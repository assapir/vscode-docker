/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, commands, debug, DebugConfiguration, DebugConfigurationProvider, MessageItem, ProviderResult, window, workspace, WorkspaceFolder } from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext } from 'vscode-azureextensionui';
import { DockerOrchestration } from '../constants';
import { ext } from '../extensionVariables';
import { localize } from '../localize';
import { getAssociatedDockerRunTask } from '../tasks/TaskHelper';
import { callDockerodeAsync } from '../utils/callDockerode';
import { DockerClient } from './coreclr/CliDockerClient';
import { DebugHelper, DockerDebugContext, ResolvedDebugConfiguration } from './DebugHelper';
import { DockerPlatform, getPlatform } from './DockerPlatformHelper';
import { NetCoreDockerDebugConfiguration } from './netcore/NetCoreDebugHelper';
import { NodeDockerDebugConfiguration } from './node/NodeDebugHelper';

export interface DockerDebugConfiguration extends NetCoreDockerDebugConfiguration, NodeDockerDebugConfiguration {
    platform?: DockerPlatform;
}

export interface DockerAttachConfiguration extends NetCoreDockerDebugConfiguration, NodeDockerDebugConfiguration {
    processName?: string;
    processId?: string | number;
}

export class DockerDebugConfigurationProvider implements DebugConfigurationProvider {
    public constructor(
        private readonly dockerClient: DockerClient,
        private readonly helpers: { [key in DockerPlatform]: DebugHelper }
    ) { }

    public provideDebugConfigurations(folder: WorkspaceFolder | undefined, token?: CancellationToken): ProviderResult<DebugConfiguration[]> {
        const add: MessageItem = { title: localize('vscode-docker.debug.configProvider.addDockerFiles', 'Add Docker Files') };

        // Prompt them to add Docker files since they probably haven't
        /* eslint-disable-next-line @typescript-eslint/no-floating-promises */
        window.showErrorMessage(
            localize('vscode-docker.debug.configProvider.toDebugAddDockerFiles', 'To debug in a Docker container on supported platforms, use the command "Docker: Add Docker Files to Workspace", or click "Add Docker Files".'),
            ...[add])
            .then((result) => {
                if (result === add) {
                    /* eslint-disable-next-line @typescript-eslint/no-floating-promises */
                    commands.executeCommand('vscode-docker.configure');
                }
            });

        return [];
    }

    public resolveDebugConfiguration(folder: WorkspaceFolder | undefined, debugConfiguration: DockerDebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration | undefined> {
        return callWithTelemetryAndErrorHandling(
            debugConfiguration.request === 'attach' ? 'docker-attach' : 'docker-launch',
            async (actionContext: IActionContext) => {
                await ext.ams.recordActivity('debug');

                if (!folder) {
                    folder = workspace.workspaceFolders[0];

                    if (!folder) {
                        throw new Error(localize('vscode-docker.debug.configProvider.workspaceFolder', 'To debug with Docker you must first open a folder or workspace in VS Code.'));
                    }
                }

                if (debugConfiguration.type === undefined) {
                    // If type is undefined, they may be doing F5 without creating any real launch.json, which won't work
                    // VSCode subsequently will call provideDebugConfigurations which will show an error message
                    return null;
                }

                if (!debugConfiguration.request) {
                    throw new Error(localize('vscode-docker.debug.configProvider.requestRequired', 'The property "request" must be specified in the debug config.'));
                }

                const debugPlatform = getPlatform(debugConfiguration);
                actionContext.telemetry.properties.dockerPlatform = debugPlatform;
                actionContext.telemetry.properties.orchestration = 'single' as DockerOrchestration; // TODO: docker-compose, when support is added

                return await this.resolveDebugConfigurationInternal(
                    {
                        folder: folder,
                        platform: debugPlatform,
                        actionContext: actionContext,
                        cancellationToken: token,
                    },
                    debugConfiguration
                );
            }
        );
    }

    private async resolveDebugConfigurationInternal(context: DockerDebugContext, originalConfiguration: DockerDebugConfiguration): Promise<DockerDebugConfiguration | undefined> {
        context.runDefinition = await getAssociatedDockerRunTask(originalConfiguration);

        const helper = this.getHelper(context.platform);
        const resolvedConfiguration = await helper.resolveDebugConfiguration(context, originalConfiguration);

        if (resolvedConfiguration) {
            await this.validateResolvedConfiguration(resolvedConfiguration);
            await this.registerRemoveContainerAfterDebugging(resolvedConfiguration);
            await this.registerOutputPortsAtDebugging(resolvedConfiguration);
        }

        return resolvedConfiguration;
    }

    private async validateResolvedConfiguration(resolvedConfiguration: ResolvedDebugConfiguration): Promise<void> {
        if (!resolvedConfiguration.type) {
            throw new Error(localize('vscode-docker.debug.configProvider.noDebugType', 'No debug type was resolved.'));
        } else if (!resolvedConfiguration.request) {
            throw new Error(localize('vscode-docker.debug.configProvider.noDebugRequest', 'No debug request was resolved.'));
        }
    }

    private async registerRemoveContainerAfterDebugging(resolvedConfiguration: ResolvedDebugConfiguration): Promise<void> {
        if (resolvedConfiguration.dockerOptions
            && (resolvedConfiguration.dockerOptions.removeContainerAfterDebug === undefined || resolvedConfiguration.dockerOptions.removeContainerAfterDebug)
            && resolvedConfiguration.dockerOptions.containerName) {

            // Since Python is a special case as we handle waiting for the debugger to be ready while resolving
            // the launch configuration, and since this method comes later then we shouldn't remove a container
            // that we just created.
            // TODO: this needs to be removed as soon as the Python extension adds a way to retry while connecting to a remote debugger.
            if (resolvedConfiguration.type !== 'python') {
                try {
                    await this.dockerClient.removeContainer(resolvedConfiguration.dockerOptions.containerName, { force: true });
                } catch { }
            }

            // Now register the container for removal after the debug session ends
            const disposable = debug.onDidTerminateDebugSession(async session => {
                const sessionConfiguration = <ResolvedDebugConfiguration>session.configuration;

                // Don't do anything if this isn't our debug session
                if (sessionConfiguration?.dockerOptions?.containerName === resolvedConfiguration.dockerOptions.containerName) {
                    try {
                        await this.dockerClient.removeContainer(resolvedConfiguration.dockerOptions.containerName, { force: true });
                    } finally {
                        disposable.dispose();
                    }
                }
            });
        }
    }

    private async registerOutputPortsAtDebugging(resolvedConfiguration: ResolvedDebugConfiguration): Promise<void> {
        if (resolvedConfiguration?.dockerOptions?.containerName) {
            const disposable = debug.onDidStartDebugSession(async session => {
                const sessionConfiguration = <ResolvedDebugConfiguration>session.configuration;

                // Don't do anything if this isn't our debug session
                if (sessionConfiguration?.dockerOptions?.containerName === resolvedConfiguration.dockerOptions.containerName) {
                    try {
                        const inspectInfo = await callDockerodeAsync(async () => ext.dockerode.getContainer(resolvedConfiguration.dockerOptions.containerName)?.inspect());
                        const portMappings: string[] = [];

                        if (inspectInfo?.NetworkSettings?.Ports) {
                            for (const containerPort of Object.keys(inspectInfo.NetworkSettings.Ports)) {
                                const mappings = inspectInfo.NetworkSettings.Ports[containerPort];

                                if (mappings) {
                                    for (const mapping of mappings) {
                                        if (mapping?.HostPort) {
                                            // TODO: if we ever do non-localhost debugging this would need to change
                                            portMappings.push(`localhost:${mapping.HostPort} => ${containerPort}`);
                                        }
                                    }
                                }
                            }
                        }

                        if (portMappings.length > 0) {
                            ext.outputChannel.appendLine(localize('vscode-docker.debug.configProvider.portMappings', 'The application is listening on the following port(s) (Host => Container):'));
                            ext.outputChannel.appendLine(portMappings.join('\n'));
                        }
                    } finally {
                        disposable.dispose();
                    }
                }
            });
        }
    }

    private getHelper(platform: DockerPlatform): DebugHelper {
        const helper = this.helpers[platform];

        if (!helper) {
            throw new Error(localize('vscode-docker.debug.configProvider.unsupportedPlatform', 'The platform \'{0}\' is not currently supported for Docker debugging.', platform));
        }

        return helper;
    }
}
