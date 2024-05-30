import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { isRateLimitError } from '@sourcegraph/cody-shared'
import * as vscode from 'vscode'
import { type CancellationToken, type MessageConnection, ResponseError, Trace } from 'vscode-jsonrpc'
import { CodyJsonRpcErrorCode } from './CodyJsonRpcErrorCode'
import type * as agent from './agent-protocol'
import type * as bfg from './bfg-protocol'
import type * as contextRanking from './context-ranking-protocol'
import type * as embeddings from './embeddings-protocol'

type Requests = bfg.Requests & agent.Requests & embeddings.Requests & contextRanking.Requests
type Notifications = bfg.Notifications &
    agent.Notifications &
    embeddings.Notifications &
    contextRanking.Notifications

// String literal types for the names of the Cody Agent protocol methods.
export type RequestMethodName = keyof Requests
export type NotificationMethodName = keyof Notifications
type MethodName = RequestMethodName | NotificationMethodName

// Parameter type of a request or notification. Note: JSON-RPC methods can only
// accept one parameter. Multiple parameters must be encoded as an array or an
// object.
type ParamsOf<K extends MethodName> = (Requests & Notifications)[K][0]
// Request result types. Note: notifications don't return values.
type ResultOf<K extends RequestMethodName> = Requests[K][1]

/**
 * Absolute path to a file where the agent can write low-level debugging logs to
 * trace all incoming/outgoing JSON messages.
 */
const tracePath = process.env.CODY_AGENT_TRACE_PATH ?? ''

export type RequestCallback<M extends RequestMethodName> = (
    params: ParamsOf<M>,
    cancelToken: vscode.CancellationToken
) => Promise<ResultOf<M>>
type NotificationCallback<M extends NotificationMethodName> = (
    params: ParamsOf<M>
) => void | Promise<void>

export class MessageHandler {
    // Tracked for `clientForThisInstance` only.
    private readonly requestHandlers = new Map<RequestMethodName, RequestCallback<any>>()
    private readonly notificationHandlers = new Map<NotificationMethodName, NotificationCallback<any>>()

    private disposables: vscode.Disposable[] = []

    constructor(public readonly conn: MessageConnection) {
        this.disposables.push(
            conn.onClose(() => {
                this.alive = false
            })
        )
        if (tracePath) {
            if (existsSync(tracePath)) {
                rmSync(tracePath)
            }
            mkdirSync(dirname(tracePath), { recursive: true })
            conn.trace(Trace.Verbose, {
                log: (messageOrDataObject: string, data?: string) => {
                    appendFileSync(tracePath, `${messageOrDataObject} ${data}\n`)
                },
            })
        }
    }

    private customizeResponseError(error: Error, token: CancellationToken): ResponseError<any> {
        const message = error instanceof Error ? error.message : `${error}`
        const stack = error instanceof Error ? `\n${error.stack}` : ''
        const code = token.isCancellationRequested
            ? CodyJsonRpcErrorCode.RequestCanceled
            : isRateLimitError(error)
              ? CodyJsonRpcErrorCode.RateLimitError
              : CodyJsonRpcErrorCode.InternalError
        return new ResponseError(
            code,
            // Include the stack in the message because
            // some JSON-RPC bindings like lsp4j don't
            // expose access to the `data` property,
            // only `message`. The stack is super
            // helpful to track down unexpected
            // exceptions.
            `${message}\n${stack}`,
            JSON.stringify({ error, stack })
        )
    }

    public registerRequest<M extends RequestMethodName>(method: M, callback: RequestCallback<M>): void {
        this.requestHandlers.set(method, callback)
        this.disposables.push(
            this.conn.onRequest(
                method,
                async (params, cancelToken: CancellationToken) =>
                    await callback(params, cancelToken).catch<ResponseError<any>>(error =>
                        this.customizeResponseError(error, cancelToken)
                    )
            )
        )
    }

    public registerNotification<M extends NotificationMethodName>(
        method: M,
        callback: NotificationCallback<M>
    ): void {
        this.notificationHandlers.set(method, callback)
        this.disposables.push(this.conn.onNotification(method, params => callback(params)))
    }

    public async request<M extends RequestMethodName>(
        method: M,
        params: ParamsOf<M>
    ): Promise<ResultOf<M>> {
        return await this.conn.sendRequest(method, params)
    }

    public notify<M extends NotificationMethodName>(method: M, params: ParamsOf<M>): Promise<void> {
        return this.conn.sendNotification(method, params)
    }

    private alive = true
    public isAlive(): boolean {
        return this.alive
    }

    /**
     * @returns A JSON-RPC client to interact directly with this agent instance. Useful when we want
     * to use the agent in-process without stdout/stdin transport mechanism.
     */
    public clientForThisInstance(): Pick<MessageHandler, 'request' | 'notify'> {
        return {
            request: async <M extends RequestMethodName>(
                method: M,
                params: ParamsOf<M>,
                cancelToken: vscode.CancellationToken = new vscode.CancellationTokenSource().token
            ) => {
                const handler = this.requestHandlers.get(method)
                if (handler) {
                    return await handler(params, cancelToken)
                }
                throw new Error(`No such request handler: ${method}`)
            },
            notify: <M extends NotificationMethodName>(method: M, params: ParamsOf<M>) => {
                const handler = this.notificationHandlers.get(method)
                if (handler) {
                    handler(params)
                }
                throw new Error(`No such notification handler: ${method}`)
            },
        }
    }

    public exit(): void {
        this.conn.end()
        this.dispose()
    }

    public dispose(): void {
        this.alive = false
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
        this.disposables = []
    }
}
