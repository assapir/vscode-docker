/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkspaceFolder } from 'vscode';
import { IActionContext } from 'vscode-azureextensionui';
import { DockerDebugScaffoldContext } from '../debugging/DebugHelper';
import { dockerDebugScaffoldingProvider } from '../debugging/DockerDebugScaffoldingProvider';
import { PythonScaffoldingOptions } from '../debugging/python/PythonDebugHelper';
import { PlatformOS } from '../utils/platform';
import { getComposePorts, getExposeStatements, IPlatformGeneratorInfo, PackageInfo } from './configure';
import { ScaffoldFile } from './scaffolding';
import { PythonExtensionHelper } from '../tasks/python/PythonExtensionHelper';

export let configurePythonDjango: IPlatformGeneratorInfo = {
  genDockerFile,
  genDockerCompose,
  genDockerComposeDebug,
  defaultPorts: [8000],
  initializeForDebugging: initializeForDebugging,
  genAdditionalFiles: genAdditionalFiles
};

function genDockerFile(serviceNameAndRelativePath: string, platform: string, os: string | undefined, ports: number[], { cmd, author, version, artifactName }: Partial<PackageInfo>): string {
  let exposeStatements = getExposeStatements(ports);

  return `# For more information, please refer to https://aka.ms/vscode-docker-python
FROM python:alpine

${exposeStatements}

# Install uWSGI prereqs
RUN apk add python3-dev build-base linux-headers pcre-dev

# Install pip requirements
ADD requirements.txt .
RUN python3 -m pip install -r requirements.txt

WORKDIR /app
ADD . /app

CMD ["uwsgi", "-http", ":${
    ports !== undefined ? ports[0] : 0
  }", "--module", "${serviceNameAndRelativePath}.wsgi"]
`;
}

function genDockerCompose(serviceNameAndRelativePath: string, platform: string, os: string | undefined, ports: number[]): string {
  return `version: '2.1'

services:
  ${serviceNameAndRelativePath}:
    image: ${serviceNameAndRelativePath}
    build: .
${getComposePorts(ports)}`;
}

function genDockerComposeDebug(serviceNameAndRelativePath: string, platform: string, os: string | undefined, ports: number[], { fullCommand: cmd }: Partial<PackageInfo>): string {
  const defaultDebugPort = 5678;
  const defaultDebugOptions : PythonExtensionHelper.DebugLaunchOptions =
  {
    host: "0.0.0.0",
    port: defaultDebugPort,
    wait: true
  };

  const file : PythonExtensionHelper.FileTarget =
  {
    file: "manage.py"
  };
  const args = [
    "runserver",
    `0.0.0.0:${ports ? ports[0] : 8000}`
  ];

  const launcherCommand = PythonExtensionHelper.getRemoteLauncherCommand(file, args, defaultDebugOptions);
  const entrypoint = 'python '.concat(launcherCommand);

  return `version: '2.1'

services:
  ${serviceNameAndRelativePath}:
    image: ${serviceNameAndRelativePath}
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - ${PythonExtensionHelper.getLauncherFolderPath()}:/pydbg
    entrypoint: ${entrypoint}
${getComposePorts(ports, defaultDebugPort)}`;
}

async function genAdditionalFiles(): Promise<ScaffoldFile[]> {
    const contents = `asgiref==3.2.3
Django==3.0.2
pytz==2019.3
sqlparse==0.3.0
uWSGI==2.0.18`;
  const fileName = 'requirements.txt'

  return [{ contents: contents, fileName: fileName }];
}

async function initializeForDebugging(context: IActionContext, folder: WorkspaceFolder, platformOS: PlatformOS, dockerfile: string, packageInfo: PackageInfo, ports: number[], generateComposeFiles: boolean): Promise<void> {
  const scaffoldContext: DockerDebugScaffoldContext = {
      folder: folder,
      platform: 'python',
      actionContext: context,
      dockerfile: dockerfile,
      ports: ports,
      generateComposeTask: generateComposeFiles
  }

  const pyOptions: PythonScaffoldingOptions = {
      projectType: 'django',
      platformOS: platformOS
  }

  await dockerDebugScaffoldingProvider.initializePythonForDebugging(scaffoldContext, pyOptions);
}