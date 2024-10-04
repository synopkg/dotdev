import http from 'node:http'
import https from 'node:https'
import { parse as parseUrl } from 'node:url'
import { agent } from '@sourcegraph/cody-shared'
import type { AuthCredentials, ClientConfiguration, ClientState } from '@sourcegraph/cody-shared'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent } from 'proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type * as vscode from 'vscode'
// @ts-ignore
import { registerLocalCertificates } from './certs'
import { getConfiguration } from './configuration'

import { validateProxySettings } from './configuration-proxy'

// The path to the exported class can be found in the npm contents
// https://www.npmjs.com/package/@vscode/proxy-agent?activeTab=code
const nodeModules = '_VSCODE_NODE_MODULES'
const proxyAgentPath = '@vscode/proxy-agent/out/agent'
const pacProxyAgent = 'PacProxyAgent'

/**
 * We use keepAlive agents here to avoid excessive SSL/TLS handshakes for autocomplete requests.
 */
let httpAgent: http.Agent
let httpsAgent: https.Agent
let socksProxyAgent: SocksProxyAgent
let httpProxyAgent: HttpProxyAgent<string>
let httpsProxyAgent: HttpsProxyAgent<string>

function getCustomAgent({
    proxy,
    proxyServer,
    proxyPath,
    proxyCACert,
}: ClientConfiguration): ({ protocol }: Pick<URL, 'protocol'>) => http.Agent {
    return ({ protocol }) => {
        const proxyURL = proxy || getSystemProxyURI(protocol, process.env)
        if (proxyURL) {
            if (proxyURL?.startsWith('socks')) {
                if (!socksProxyAgent) {
                    socksProxyAgent = new SocksProxyAgent(proxyURL, {
                        keepAlive: true,
                        keepAliveMsecs: 60000,
                    })
                }
                return socksProxyAgent
            }
            const proxyEndpoint = parseUrl(proxyURL)

            const opts = {
                host: proxyEndpoint.hostname || '',
                port:
                    (proxyEndpoint.port ? +proxyEndpoint.port : 0) ||
                    (proxyEndpoint.protocol === 'https' ? 443 : 80),
                auth: proxyEndpoint.auth,
                rejectUnauthorized: true,
                keepAlive: true,
                keepAliveMsecs: 60000,
                ...https.globalAgent.options,
            }
            if (protocol === 'http:') {
                if (!httpProxyAgent) {
                    httpProxyAgent = new HttpProxyAgent(proxyURL, opts)
                }
                return httpProxyAgent
            }

            if (!httpsProxyAgent) {
                httpsProxyAgent = new HttpsProxyAgent(proxyURL, opts)
            }
            return httpsProxyAgent
        }

        if (proxyServer || proxyPath) {
            const [proxyHost, proxyPort] = proxyServer ? proxyServer.split(':') : [undefined, undefined]

            // Combine the CA certs from the global options with the one(s) defined in settings,
            // otherwise the CA cert in the settings overrides all of the global agent options
            // (or the other way around, depending on the order of the options).
            const caCerts = (() => {
                if (proxyCACert) {
                    return [proxyCACert]
                    // if (Array.isArray(https.globalAgent.options.ca)) {
                    //     return [...https.globalAgent.options.ca, proxyCACert]
                    // }
                    // return [https.globalAgent.options.ca, proxyCACert]
                }
                return undefined
            })()
            const agent = new ProxyAgent({
                protocol: protocol || 'https:',
                ...(proxyServer ? { host: proxyHost, port: Number(proxyPort) } : null),
                ...(proxyPath ? { socketPath: proxyPath } : null),
                keepAlive: true,
                keepAliveMsecs: 60000,
                ...https.globalAgent.options,
                // Being at the end, this will override https.globalAgent.options.ca
                ...(caCerts ? { ca: caCerts } : null),
            })
            return agent
        }

        return protocol === 'http:' ? httpAgent : httpsAgent
    }
}

export function setCustomAgent(
    configuration: ClientConfiguration
): ({ protocol }: Pick<URL, 'protocol'>) => http.Agent {
    agent.current = getCustomAgent(configuration)
    return agent.current as ({ protocol }: Pick<URL, 'protocol'>) => http.Agent
}

function getSystemProxyURI(protocol: string, env: typeof process.env): string | null {
    if (protocol === 'http:') {
        return env.HTTP_PROXY || env.http_proxy || null
    }
    if (protocol === 'https:') {
        return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null
    }
    if (protocol.startsWith('socks')) {
        return env.SOCKS_PROXY || env.socks_proxy || null
    }
    return null
}

export function initializeNetworkAgent(context: Pick<vscode.ExtensionContext, 'extensionUri'>): void {
    // This is to load certs for HTTPS requests
    registerLocalCertificates(context)
    httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 60000 })
    httpsAgent = new https.Agent({
        ...https.globalAgent.options,
        keepAlive: true,
        keepAliveMsecs: 60000,
    })

    const customAgent = setCustomAgent(
        validateProxySettings({
            configuration: getConfiguration(),
            auth: {} as AuthCredentials,
            clientState: {} as ClientState,
        })
    )

    /**
     * This works around an issue in the default VS Code proxy agent code. When `http.proxySupport`
     * is set to its default value and no proxy setting is being used, the proxy library does not
     * properly reuse the agent set on the http(s) method and is instead always using a new agent
     * per request.
     *
     * To work around this, we patch the default proxy agent method and overwrite the
     * `originalAgent` value before invoking it for requests that want to keep their connection
     * alive (as indicated by the `Connection: keep-alive` header).
     *
     * c.f. https://github.com/microsoft/vscode/issues/173861
     */
    try {
        const PacProxyAgent =
            (globalThis as any)?.[nodeModules]?.[proxyAgentPath]?.[pacProxyAgent] ?? customAgent
        if (PacProxyAgent) {
            const originalConnect = PacProxyAgent.prototype.connect
            // Patches the implementation defined here:
            // https://github.com/microsoft/vscode-proxy-agent/blob/d340b9d34684da494d6ebde3bcd18490a8bbd071/src/agent.ts#L53
            PacProxyAgent.prototype.connect = function (
                req: http.ClientRequest,
                opts: { protocol: string }
            ): any {
                try {
                    const connectionHeader = req.getHeader('connection')
                    if (
                        connectionHeader === 'keep-alive' ||
                        (Array.isArray(connectionHeader) && connectionHeader.includes('keep-alive'))
                    ) {
                        this.opts.originalAgent = customAgent(opts)
                        return originalConnect.call(this, req, opts)
                    }
                    return originalConnect.call(this, req, opts)
                } catch {
                    return originalConnect.call(this, req, opts)
                }
            }
        }
    } catch (error) {
        // Ignore any errors in the patching logic
        void error
    }
}
