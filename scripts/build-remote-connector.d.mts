export interface RemoteConnectorBuildResult {
  outputRoot: string;
  inputs: string[];
}

export function buildRemoteConnector(outputRoot: string): Promise<RemoteConnectorBuildResult>;
