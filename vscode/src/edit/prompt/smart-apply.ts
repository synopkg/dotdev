import {
    BotResponseMultiplexer,
    type ChatClient,
    type ChatMessage,
    type EditModel,
    type Message,
    ModelsService,
    PromptString,
    TokenCounter,
    getSimplePreamble,
    ps,
    psDedent,
} from '@sourcegraph/cody-shared'
import * as vscode from 'vscode'
import { PromptBuilder } from '../../prompt-builder'
import { fuzzyFindLocation } from '../../supercompletions/utils/fuzzy-find-location'

const SMART_APPLY_TOPICS = {
    FILE_CONTENTS: ps`FILE_CONTENTS`,
    INCOMING: ps`INCOMING`,
    ORIGINAL: ps`ORIGINAL`,
} as const

const RESPONSE_PREFIX = ps`<${SMART_APPLY_TOPICS.ORIGINAL}>`
const SHARED_PARAMETERS = {
    stopSequences: [`</${SMART_APPLY_TOPICS.ORIGINAL}>`],
    assistantText: RESPONSE_PREFIX,
    assistantPrefix: RESPONSE_PREFIX,
}

const SMART_APPLY_PREFIX = `<${SMART_APPLY_TOPICS.ORIGINAL}>`

export const SMART_APPLY_PROMPT = {
    system: psDedent`
        - You are an AI programming assistant who is an expert in determiing the best way to apply a change to a codebase.
        - Given a change, and the file where that change should be applied, you should determine the best way to apply the change to the file.
        - You will be provided with the contents of the current active file, enclosed in <${SMART_APPLY_TOPICS.FILE_CONTENTS}></${SMART_APPLY_TOPICS.FILE_CONTENTS}> XML tags.
        - You will be provided with an incoming change to a file, enclosed in <${SMART_APPLY_TOPICS.INCOMING}></${SMART_APPLY_TOPICS.INCOMING}> XML tags.
        - You should respond with the original code that should be updated, enclosed in <${SMART_APPLY_TOPICS.ORIGINAL}></${SMART_APPLY_TOPICS.ORIGINAL}> XML tags.
        - If this code should not replace any existing code, you should provide an empty <${SMART_APPLY_TOPICS.ORIGINAL}></${SMART_APPLY_TOPICS.ORIGINAL}> XML tag, at the position where the new code should be inserted.\
        - We will paste the incoming change to replace the original code you produce, so ensure that the original code contains all code that should be replaced.
        - Do not provide any additional commentary about the changes you made. Only respond with the generated code.`,
    instruction: psDedent`
        We are in the file: {filePath}

        This file contains the following code:
        <${SMART_APPLY_TOPICS.FILE_CONTENTS}>{fileContents}</${SMART_APPLY_TOPICS.FILE_CONTENTS}>

        We have the following code to apply to the file:
        <${SMART_APPLY_TOPICS.INCOMING}>{incomingText}</${SMART_APPLY_TOPICS.INCOMING}>

        You should respond with the original code that should be updated, enclosed in <${SMART_APPLY_TOPICS.ORIGINAL}></${SMART_APPLY_TOPICS.ORIGINAL}> XML tags.
    `,
}

export const getPrompt = async (
    replacement: string,
    document: vscode.TextDocument,
    model: EditModel
): Promise<{ messages: Message[]; prefix: string }> => {
    const documentRange = new vscode.Range(0, 0, document.lineCount - 1, 0)
    const documentText = PromptString.fromDocumentText(document, documentRange)
    const tokenCount = TokenCounter.countPromptString(documentText)
    const contextWindow = ModelsService.getContextWindowByID(model)
    if (tokenCount > contextWindow.input) {
        throw new Error("The amount of text in this document exceeds Cody's current capacity.")
    }
    const promptBuilder = new PromptBuilder(contextWindow)

    // TODO: Implement api version
    const fakeApiVersion = 5
    const preamble = getSimplePreamble(model, fakeApiVersion, SMART_APPLY_PROMPT.system)
    promptBuilder.tryAddToPrefix(preamble)

    const instruction = SMART_APPLY_PROMPT.instruction
        .replaceAll('{incomingText}', PromptString.unsafe_fromLLMResponse(replacement))
        .replaceAll('{fileContents}', documentText)
        .replaceAll('{filePath}', PromptString.fromDisplayPath(document.uri))

    const transcript: ChatMessage[] = [{ speaker: 'human', text: instruction }]
    transcript.push({ speaker: 'assistant', text: SHARED_PARAMETERS.assistantText })

    promptBuilder.tryAddMessages(transcript.reverse())

    return { prefix: SMART_APPLY_PREFIX, messages: promptBuilder.build() }
}

export async function promptModelForOriginalCode(
    replacement: string,
    document: vscode.TextDocument,
    model: EditModel,
    client: ChatClient
): Promise<string> {
    const multiplexer = new BotResponseMultiplexer()
    const contextWindow = ModelsService.getContextWindowByID(model)

    let text = ''
    multiplexer.sub(SMART_APPLY_TOPICS.ORIGINAL.toString(), {
        onResponse: async (content: string) => {
            text += content
        },
        onTurnComplete: async () => {
            Promise.resolve(text)
        },
    })

    const abortController = new AbortController()
    const { prefix, messages } = await getPrompt(replacement, document, model)
    const stream = client.chat(
        messages,
        {
            model,
            stopSequences: [],
            maxTokensToSample: contextWindow.output,
        },
        abortController.signal
    )

    let textConsumed = 0
    for await (const message of stream) {
        switch (message.type) {
            case 'change': {
                if (textConsumed === 0 && prefix) {
                    void multiplexer.publish(prefix)
                }
                const text = message.text.slice(textConsumed)
                textConsumed += text.length
                void multiplexer.publish(text)
                break
            }
            case 'complete': {
                void multiplexer.notifyTurnComplete()
                break
            }
        }
    }

    return text
}

export async function getSmartApplySelection(
    replacement: string,
    document: vscode.TextDocument,
    model: EditModel,
    client: ChatClient
): Promise<vscode.Selection | null> {
    const originalCode = await promptModelForOriginalCode(replacement, document, model, client)
    const fuzzyLocation = fuzzyFindLocation(document, originalCode)
    if (!fuzzyLocation) {
        return null
    }

    const range = fuzzyLocation.location.range
    return new vscode.Selection(range.start, range.end)
}
