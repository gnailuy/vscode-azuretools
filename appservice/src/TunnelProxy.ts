/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { User } from 'azure-arm-website/lib/models';
import * as EventEmitter from 'events';
import { IncomingMessage } from 'http';
import { createServer, Server, Socket } from 'net';
import * as requestP from 'request-promise';
import { IParsedError, parseError } from 'vscode-azureextensionui';
import * as websocket from 'websocket';
import { ext } from './extensionVariables';
import { localize } from './localize';
import { SiteClient } from './SiteClient';
import { delay } from './utils/delay';

/**
 * Wrapper for net.Socket that forwards all traffic to the Kudu tunnel websocket endpoint.
 * Used internally by the TunnelProxy server.
 */
class TunnelSocket extends EventEmitter {
    private _socket: Socket;
    private _client: SiteClient;
    private _publishCredential: User;
    private _wsConnection: websocket.connection | undefined;
    private _wsClient: websocket.client;

    constructor(socket: Socket, client: SiteClient, publishCredential: User) {
        super();
        this._socket = socket;
        this._client = client;
        this._publishCredential = publishCredential;
        this._wsClient = new websocket.client();
    }

    public connect(): void {
        ext.outputChannel.appendLine('[Proxy Server] socket init');

        // Pause socket until tunnel connection has been established to make sure we don't lose data
        this._socket.pause();

        this._socket.on('data', (data: Buffer) => {
            if (this._wsConnection) {
                this._wsConnection.send(data);
            }
        });

        this._socket.on('close', () => {
            ext.outputChannel.appendLine(`[Proxy Server] client disconnected ${this._socket.remoteAddress}:${this._socket.remotePort}`);
            this.dispose();
            this.emit('close');
        });

        this._socket.on('error', (err: Error) => {
            ext.outputChannel.appendLine(`[Proxy Server] socket error: ${err}`);
            this.dispose();
            this.emit('error', err);
        });

        this._wsClient.on('connect', (connection: websocket.connection) => {
            ext.outputChannel.appendLine('[WebSocket] client connected');
            this._wsConnection = connection;

            // Resume socket after connection
            this._socket.resume();

            connection.on('close', () => {
                ext.outputChannel.appendLine('[WebSocket] client closed');
                this.dispose();
                this.emit('close');
            });

            connection.on('error', (err: Error) => {
                ext.outputChannel.appendLine(`[WebSocket] error: ${err}`);
                this.dispose();
                this.emit('error', err);
            });

            connection.on('message', (data: websocket.IMessage) => {
                this._socket.write(data.binaryData);
            });

        });

        this._wsClient.on('connectFailed', (err: Error) => {
            ext.outputChannel.appendLine(`[WebSocket] connectFailed: ${err}`);
            this.dispose();
            this.emit('error', err);
        });

        this._wsClient.connect(
            `wss://${this._client.kuduHostName}/AppServiceTunnel/Tunnel.ashx`,
            undefined,
            undefined,
            {
                'User-Agent': 'vscode-azuretools',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache'
            },
            {
                auth: `${this._publishCredential.publishingUserName}:${this._publishCredential.publishingPassword}`
            }
        );
    }

    public dispose(): void {
        ext.outputChannel.appendLine('[Proxy Server] socket dispose');

        if (this._wsConnection) {
            this._wsConnection.close();
            this._wsConnection = undefined;
        }

        this._wsClient.abort();

        this._socket.destroy();
    }
}

/**
 * Interface for tunnel GetStatus API
 */
enum AppState {
    STARTED = 'STARTED',
    STARTING = 'STARTING',
    STOPPED = 'STOPPED'
}

interface ITunnelStatus {
    port: number;
    canReachPort: boolean;
    state: AppState;
    msg: string;
}

/**
 * Internal error indicating that we should continue to retry getting the tunnel status
 */
class RetryableTunnelStatusError extends Error { }

/**
 * A local TCP server that forwards all connections to the Kudu tunnel websocket endpoint.
 */
export class TunnelProxy {
    private _port: number;
    private _client: SiteClient;
    private _publishCredential: User;
    private _server: Server;
    private _openSockets: TunnelSocket[];
    private _isSsh: boolean;

    constructor(port: number, client: SiteClient, publishCredential: User, isSsh: boolean = false) {
        this._port = port;
        this._client = client;
        this._publishCredential = publishCredential;
        this._server = createServer();
        this._openSockets = [];
        this._isSsh = isSsh;
    }

    public async startProxy(): Promise<void> {
        await this.checkTunnelStatusWithRetry();
        await this.setupTunnelServer();
    }

    public dispose(): void {
        this._openSockets.forEach((tunnelSocket: TunnelSocket) => {
            tunnelSocket.dispose();
        });
        this._server.close();
        this._server.unref();
    }

    // Starts up an app by pinging it when it is found to be in the STOPPED state
    private async startupApp(): Promise<void> {
        ext.outputChannel.appendLine('[Tunnel] Pinging app default url...');
        // tslint:disable-next-line:no-unsafe-any
        const pingResponse: IncomingMessage = await requestP.get({
            uri: this._client.defaultHostUrl,
            simple: false, // allows the call to succeed without exception, even when status code is not 2XX
            resolveWithFullResponse: true // allows access to the status code from the response
        });
        ext.outputChannel.appendLine(`[Tunnel] Ping responded with status code: ${pingResponse.statusCode}`);
    }

    private async checkTunnelStatus(): Promise<void> {
        const statusOptions: requestP.Options = {
            uri: `https://${this._client.kuduHostName}/AppServiceTunnel/Tunnel.ashx?GetStatus&GetStatusAPIVer=2`,
            headers: {
                'User-Agent': 'vscode-azuretools'
            },
            auth: {
                user: this._publishCredential.publishingUserName,
                pass: this._publishCredential.publishingPassword
            }
        };

        let tunnelStatus: ITunnelStatus;
        try {
            // tslint:disable-next-line:no-unsafe-any
            const responseBody: string = await requestP.get(statusOptions);
            ext.outputChannel.appendLine(`[Tunnel] Checking status, body: ${responseBody}`);

            // tslint:disable-next-line:no-unsafe-any
            tunnelStatus = JSON.parse(responseBody);
        } catch (error) {
            const parsedError: IParsedError = parseError(error);
            ext.outputChannel.appendLine(`[Tunnel] Checking status, error: ${parsedError.message}`);
            throw new Error(localize('tunnelStatusError', 'Error getting tunnel status: {0}', parsedError.errorType));
        }

        if (tunnelStatus.state === AppState.STARTED) {
            if ((tunnelStatus.port === 2222 && !this._isSsh) || (tunnelStatus.port !== 2222 && this._isSsh)) {
                // Tunnel is pointed to default SSH port and still needs time to restart
                throw new RetryableTunnelStatusError();
            } else if (tunnelStatus.canReachPort) {
                return;
            } else {
                throw new Error(localize('tunnelUnreachable', 'App is started, but port is unreachable'));
            }
        } else if (tunnelStatus.state === AppState.STARTING) {
            throw new RetryableTunnelStatusError();
        } else if (tunnelStatus.state === AppState.STOPPED) {
            await this.startupApp();
            throw new RetryableTunnelStatusError();
        } else {
            throw new Error(localize('tunnelStatusError', 'Unexpected app state: {0}', tunnelStatus.state));
        }
    }

    private async checkTunnelStatusWithRetry(): Promise<void> {
        const timeoutSeconds: number = 240; // 4 minutes, matches App Service internal timeout for starting up an app
        const timeoutMs: number = timeoutSeconds * 1000;
        const pollingIntervalMs: number = 5000;

        return new Promise<void>(async (resolve: () => void, reject: (error: Error) => void): Promise<void> => {
            const start: number = Date.now();
            while (Date.now() < start + timeoutMs) {
                try {
                    await this.checkTunnelStatus();
                    resolve();
                    return;
                } catch (error) {
                    if (!(error instanceof RetryableTunnelStatusError)) {
                        reject(new Error(localize('tunnelFailed', 'Unable to establish connection to application: {0}', parseError(error).message)));
                        return;
                    } // else allow retry
                }

                await delay(pollingIntervalMs);
            }
            reject(new Error(localize('tunnelTimedOut', 'Unable to establish connection to application: Timed out')));
        });
    }

    private async setupTunnelServer(): Promise<void> {
        return new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
            this._server.on('connection', (socket: Socket) => {
                const tunnelSocket: TunnelSocket = new TunnelSocket(socket, this._client, this._publishCredential);

                this._openSockets.push(tunnelSocket);
                tunnelSocket.on('close', () => {
                    const index: number = this._openSockets.indexOf(tunnelSocket);
                    if (index >= 0) {
                        this._openSockets.splice(index, 1);
                        ext.outputChannel.appendLine(`[Proxy Server] client closed, connection count: ${this._openSockets.length}`);
                    }
                });

                tunnelSocket.connect();
                ext.outputChannel.appendLine(`[Proxy Server] client connected ${socket.remoteAddress}:${socket.remotePort}, connection count: ${this._openSockets.length}`);
            });

            this._server.on('listening', () => {
                ext.outputChannel.appendLine('[Proxy Server] start listening');
                resolve();
            });

            this._server.on('error', (err: Error) => {
                ext.outputChannel.appendLine(`[Proxy Server] server error: ${err}`);
                this.dispose();
                reject(err);
            });

            this._server.listen({
                host: 'localhost',
                port: this._port,
                backlog: 1
            });
        });
    }
}
