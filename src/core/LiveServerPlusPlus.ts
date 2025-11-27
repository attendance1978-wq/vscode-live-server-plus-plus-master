import * as vscode from 'vscode';
import * as http from 'http';
import * as WebSocket from 'ws';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { readFileStream } from './FileSystem';
import { INJECTED_TEXT, isInjectableFile } from './utils';
import {
  ILiveServerPlusPlus,
  GoOfflineEvent,
  GoLiveEvent,
  ServerErrorEvent,
  IMiddlewareTypes,
  ILiveServerPlusPlusServiceCtor,
  ILSPPIncomingMessage,
  ILiveServerPlusPlusConfig
} from './types';
import { LSPPError } from './LSPPError';
import urlJoin from '../extension/utils/urlJoin';
import extensionConfig, { ReloadingStrategy } from '../extension/utils/extensionConfig';

interface IWsWatcher {
  watchingPaths: string[]; // relative paths
  client: WebSocket;
}

type BroadcastActions = 'hot' | 'partial-reload' | 'reload' | 'refreshcss';

export class LiveServerPlusPlus implements ILiveServerPlusPlus {
  port!: number;
  private cwd: string | undefined;
  private server: http.Server | undefined;
  private ws: WebSocket.Server | undefined;
  private indexFile!: string;
  private debounceTimeout!: number;
  private reloadingStrategy!: ReloadingStrategy;
  private goLiveEvent: vscode.EventEmitter<GoLiveEvent>;
  private goOfflineEvent: vscode.EventEmitter<GoOfflineEvent>;
  private serverErrorEvent: vscode.EventEmitter<ServerErrorEvent>;
  private middlewares: IMiddlewareTypes[] = [];
  private wsWatcherList: IWsWatcher[] = [];

  constructor(config: ILiveServerPlusPlusConfig) {
    this.init(config);
    this.goLiveEvent = new vscode.EventEmitter();
    this.goOfflineEvent = new vscode.EventEmitter();
    this.serverErrorEvent = new vscode.EventEmitter();
  }

  get onDidGoLive() {
    return this.goLiveEvent.event;
  }

  get onDidGoOffline() {
    return this.goOfflineEvent.event;
  }

  get onServerError() {
    return this.serverErrorEvent.event;
  }

  get isServerRunning() {
    return this.server?.listening ?? false;
  }

  reloadConfig(config: ILiveServerPlusPlusConfig) {
    this.init(config);
  }

  async goLive() {
    if (this.isServerRunning) {
      return this.serverErrorEvent.fire({
        LSPP: this,
        code: 'serverIsAlreadyRunning',
        message: 'Server is already running'
      });
    }
    try {
      await this.listenServer();
      this.registerOnChangeReload();
      this.goLiveEvent.fire({ LSPP: this });
    } catch (error: unknown) {
      if (error instanceof Error && (error as any).code === 'EADDRINUSE') {
        return this.serverErrorEvent.fire({
          LSPP: this,
          code: 'portAlreadyInUse',
          message: `${this.port} is already in use!`
        });
      }

      if (error instanceof Error) {
        return this.serverErrorEvent.fire({
          LSPP: this,
          code: error.name,
          message: error.message
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.isServerRunning) {
      return this.serverErrorEvent.fire({
        LSPP: this,
        code: 'serverIsNotRunning',
        message: 'Server is not running'
      });
    }
    await this.closeWs();
    await this.closeServer();
    this.goOfflineEvent.fire({ LSPP: this });
  }

  useMiddleware(...fns: IMiddlewareTypes[]) {
    fns.forEach(fn => this.middlewares.push(fn));
  }

  useService(...fns: ILiveServerPlusPlusServiceCtor[]) {
    fns.forEach(fn => {
      const instance = new fn(this);
      instance.register.call(instance);
    });
  }

  private init(config: ILiveServerPlusPlusConfig) {
    this.cwd = config.cwd;
    this.indexFile = config.indexFile || 'index.html';
    this.port = config.port || extensionConfig.port;
    this.debounceTimeout = config.debounceTimeout || 400;
    this.reloadingStrategy = config.reloadingStrategy || extensionConfig.reloadingStrategy;
  }

  private registerOnChangeReload() {
    let timeout: NodeJS.Timeout;
    vscode.workspace.onDidChangeTextDocument(event => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const fileName = event.document.fileName;
        const action = this.getReloadingActionType(fileName);
        const filePathFromRoot = urlJoin(fileName.replace(this.cwd!, ''));
        this.broadcastWs(
          {
            dom:
              ['hot', 'partial-reload'].includes(action)
                ? event.document.getText()
                : undefined,
            fileName: filePathFromRoot
          },
          action
        );
      }, this.debounceTimeout);
    });
  }

  private getReloadingActionType(fileName: string): BroadcastActions {
    const extName = path.extname(fileName);
    const isCSS = extName === '.css';
    const isInjectable = isInjectableFile(fileName);

    if (isCSS) return 'refreshcss';
    if (isInjectable) return this.reloadingStrategy;
    return 'reload';
  }

  private listenServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.cwd) {
        return reject(new LSPPError('CWD is not defined', 'cwdUndefined'));
      }

      this.server = http.createServer(this.routesHandler.bind(this));

      const onPortError = reject;
      this.server.on('error', onPortError);

      this.attachWSListeners();
      this.server.listen(this.port, () => {
        this.server!.removeListener('error', onPortError);
        resolve();
      });
    });
  }

  private closeServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server!.close(err => (err ? reject(err) : resolve()));
    });
  }

  private closeWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return resolve();
      this.ws.close(err => (err ? reject(err) : resolve()));
    });
  }

  private broadcastWs(
    data: { dom?: string; fileName: string },
    action: BroadcastActions = 'reload'
  ) {
    if (!this.ws) return;

    let clients: WebSocket[] = this.ws.clients as any;

    if (isInjectableFile(data.fileName)) {
      clients = this.wsWatcherList.reduce((allClients, { client, watchingPaths }) => {
        if (this.isInWatchingList(data.fileName, watchingPaths))
          allClients.push(client);
        return allClients;
      }, [] as WebSocket[]);
    }

    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ data, action }));
      }
    });
  }

  private isInWatchingList(target: string, dirList: string[]): boolean {
    for (let dir of dirList) {
      if (!path.extname(dir)) dir = urlJoin(dir, this.indexFile);
      if (target.startsWith('/')) target = target.substr(1);
      if (dir.startsWith('/')) dir = dir.substr(1);
      if (dir === target) return true;
    }
    return false;
  }

  private attachWSListeners() {
    if (!this.server) throw new Error('Server is not defined');

    this.ws = new WebSocket.Server({ noServer: true });

    this.ws.on('connection', ws => {
      ws.send(JSON.stringify({ action: 'connected' }));
      ws.on('message', (_data: string) => {
        const { watchList } = JSON.parse(_data);
        if (watchList) this.addToWsWatcherList(ws as any, watchList);
      });
      ws.on('close', () => this.removeFromWsWatcherList(ws as any));
    });

    this.server.on('upgrade', (request, socket, head) => {
      if (request.url === '/_ws_lspp') {
        this.ws!.handleUpgrade(request, socket, head, ws => {
          this.ws!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });
  }

  private removeFromWsWatcherList(client: WebSocket) {
    const index = this.wsWatcherList.findIndex(e => e.client === client);
    if (index !== -1) this.wsWatcherList.splice(index, 1);
  }

  private addToWsWatcherList(client: WebSocket, watchDirs: string | string[]) {
    const _watchDirs = Array.isArray(watchDirs) ? watchDirs : [watchDirs];
    this.wsWatcherList.push({ client, watchingPaths: _watchDirs });
  }

  private applyMiddlware(req: IncomingMessage, res: ServerResponse) {
    this.middlewares.forEach(middleware => middleware(req, res));
  }

  private routesHandler(req: ILSPPIncomingMessage, res: ServerResponse) {
    const cwd = this.cwd;
    if (!cwd) return res.end('Root Path is missing');

    this.applyMiddlware(req, res);

    const file = req.file!;
    const filePath = path.isAbsolute(file) ? file : path.join(cwd, file);
    const contentType = req.contentType || '';
    const fileStream = readFileStream(
      filePath,
      contentType.includes('image') ? undefined : 'utf8'
    );

    fileStream.on('open', () => {
      if (isInjectableFile(filePath)) res.write(INJECTED_TEXT);
      fileStream.pipe(res);
    });

    fileStream.on('error', err => {
      console.error('ERROR ', err);
      res.statusCode = err.code === 'ENOENT' ? 404 : 500;
      return res.end(null);
    });
  }
}
