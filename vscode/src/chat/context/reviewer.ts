import type { Span } from '@opentelemetry/api'
import {
    BotResponseMultiplexer,
    type ChatClient,
    type CompletionParameters,
    type ContextItem,
    PromptString,
    currentAuthStatusAuthed,
    isDotCom,
    logDebug,
    modelsService,
} from '@sourcegraph/cody-shared'
import { getContextFileFromWorkspaceFsPath } from '../../commands/context/file-path'
import { getContextFileFromShell } from '../../commands/context/shell'
import { getCategorizedMentions } from '../../prompt-builder/unique-context'
import type { ChatModel } from '../chat-view/ChatModel'
import { type ContextRetriever, toStructuredMentions } from '../chat-view/ContextRetriever'
import { DefaultPrompter } from '../chat-view/prompt'
import { getCorpusContextItemsForEditorState } from '../clientStateBroadcaster'

export class ContextReviewer {
    private responses: Record<string, string> = {
        CODYTOOLCLI: '',
        CODYTOOLFILE: '',
        CODYTOOLSEARCH: '',
    }
    private multiplexer: BotResponseMultiplexer
    private authStatus = currentAuthStatusAuthed()

    constructor(
        private readonly chatModel: ChatModel,
        private readonly chatClient: ChatClient,
        private readonly contextRetriever: ContextRetriever,
        private span: Span,
        public currentContext: ContextItem[]
    ) {
        this.multiplexer = new BotResponseMultiplexer()
        this.initializeMultiplexer()
    }

    private initializeMultiplexer(): void {
        for (const key of Object.keys(this.responses)) {
            this.multiplexer.sub(key, {
                onResponse: async (c: string) => {
                    this.responses[key] += c
                },
                onTurnComplete: async () => Promise.resolve(),
            })
        }
    }

    private get hasContextRequest(): boolean {
        return Object.values(this.responses).some(res => res !== '')
    }

    public async getSmartContext(abortSignal: AbortSignal): Promise<ContextItem[]> {
        await this.review(abortSignal)
        if (!this.hasContextRequest) {
            return []
        }
        const smartContext = await this.getContext()
        // TODO: Run this in a loop to review the context?
        // If we have retrieved more context from the search query response,
        // run review again to review the new context and get smarter context if available.
        if (smartContext.length && this.responses.CODYTOOLSEARCH) {
            this.currentContext.push(...smartContext)
            await this.review(abortSignal)
            // Only get additional context if there's a new request
            if (this.hasContextRequest) {
                const secondRound = await this.getContext()
                smartContext.push(...secondRound)
            }
        }
        return smartContext
    }

    private async getContext(): Promise<ContextItem[]> {
        const [cliContext, fileContext, searchContext] = await Promise.all([
            this.getCommandContext(),
            this.getFileContext(),
            this.getSearchContext(),
        ])
        return [...cliContext, ...fileContext, ...searchContext]
    }

    private getItems(key: string, tag: string): string[] {
        return this.responses[key].replaceAll(`</${tag}>`, '').split(`<${tag}>`).slice(1)
    }

    private async getCommandContext(): Promise<ContextItem[]> {
        const commands = this.getItems('CODYTOOLCLI', 'cmd')
        if (!commands.length) {
            return []
        }
        return (await Promise.all(commands.map(cmd => getContextFileFromShell(cmd.trim())))).flat()
    }

    private async getFileContext(): Promise<ContextItem[]> {
        const fsPaths = this.getItems('CODYTOOLFILE', 'file')
        if (!fsPaths.length) {
            return []
        }
        logDebug('ContextReviewer', 'getFileContext', { verbose: { fsPaths } })
        return (
            await Promise.all(fsPaths.map(path => getContextFileFromWorkspaceFsPath(path.trim())))
        ).filter((item): item is ContextItem => item !== null)
    }

    private performedSearch = new Set<string>()
    private async getSearchContext(): Promise<ContextItem[]> {
        if (!this.contextRetriever || !this.responses.CODYTOOLSEARCH) {
            return []
        }
        const query = this.getItems('CODYTOOLSEARCH', 'query')?.[0]?.trim()
        if (!query || this.performedSearch.has(query)) {
            return []
        }
        this.performedSearch.add(query)
        const useRemote = !isDotCom(this.authStatus)
        const codebase = await getCorpusContextItemsForEditorState(useRemote)
        const context = await this.contextRetriever.retrieveContext(
            toStructuredMentions(codebase),
            PromptString.unsafe_fromLLMResponse(query),
            this.span
        )
        // Returns the first 20 items from the search context
        return context.slice(0, 20)
    }

    private async review(abortSignal: AbortSignal): Promise<void> {
        this.reset()
        const { explicitMentions, implicitMentions } = getCategorizedMentions(this.currentContext)
        const prompter = new DefaultPrompter(explicitMentions, implicitMentions.slice(-20))
        const { prompt } = await prompter.makePrompt(
            this.chatModel,
            this.authStatus.codyApiVersion,
            true
        )

        const params = {
            model: this.chatModel.modelID,
            maxTokensToSample: this.chatModel.contextWindow.output,
            stream: !modelsService.isStreamDisabled(this.chatModel.modelID),
        } as CompletionParameters

        let streamed = ''
        const stream = this.chatClient.chat(prompt, params, abortSignal)

        try {
            for await (const message of stream) {
                if (message.type === 'change') {
                    const text = message.text.slice(streamed.length)
                    streamed += text
                    this.publish(text)
                } else if (message.type === 'complete' || message.type === 'error') {
                    await this.notifyTurnComplete()
                    logDebug('ContextReviewer', 'Context review turn complete', {
                        verbose: { prompt, streamed },
                    })
                    break
                }
            }
        } catch (error: unknown) {
            await this.notifyTurnComplete()
            logDebug('ContextReviewer failed', `${error}`, { verbose: { prompt, streamed } })
        }
    }

    private async publish(text: string): Promise<void> {
        await this.multiplexer.publish(text)
    }

    private async notifyTurnComplete(): Promise<void> {
        await this.multiplexer.notifyTurnComplete()
    }

    private reset(): void {
        this.responses = {
            CODYTOOLCLI: '',
            CODYTOOLFILE: '',
            CODYTOOLSEARCH: '',
        }
    }
}
