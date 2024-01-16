import { type URI } from 'vscode-uri'

export interface ActiveTextEditor {
    content: string
    fileUri: URI
    repoName?: string
    revision?: string
    selectionRange?: ActiveTextEditorSelectionRange

    ignored?: boolean
}

export interface ActiveTextEditorSelectionRange {
    start: {
        line: number
        character: number
    }
    end: {
        line: number
        character: number
    }
}

export interface ActiveTextEditorSelection {
    fileUri: URI
    repoName?: string
    revision?: string
    precedingText: string
    selectedText: string
    followingText: string
    selectionRange?: ActiveTextEditorSelectionRange | null
}

export type ActiveTextEditorDiagnosticType = 'error' | 'warning' | 'information' | 'hint'

export interface ActiveTextEditorDiagnostic {
    type: ActiveTextEditorDiagnosticType
    range: ActiveTextEditorSelectionRange
    text: string
    message: string
}

export interface ActiveTextEditorVisibleContent {
    content: string
    fileUri: URI
    repoName?: string
    revision?: string
}

export interface VsCodeCommandsController {
    menu(type: 'custom' | 'config' | 'default', showDesc?: boolean): Promise<void>
}

export interface ActiveTextEditorViewControllers<C extends VsCodeCommandsController = VsCodeCommandsController> {
    readonly command?: C
}

export interface Editor<P extends VsCodeCommandsController = VsCodeCommandsController> {
    controllers?: ActiveTextEditorViewControllers<P>

    /**
     * The path of the workspace root if on the file system, otherwise `null`.
     * @deprecated Use {@link Editor.getWorkspaceRootUri} instead.
     */
    getWorkspaceRootPath(): string | null

    /** The URI of the workspace root. */
    getWorkspaceRootUri(): URI | null

    getActiveTextEditor(): ActiveTextEditor | null
    getActiveTextEditorSelection(): ActiveTextEditorSelection | null
    getActiveTextEditorSmartSelection(): Promise<ActiveTextEditorSelection | null>

    /**
     * Gets the active text editor's selection, or the entire file if the selected range is empty.
     */
    getActiveTextEditorSelectionOrEntireFile(): ActiveTextEditorSelection | null
    /**
     * Gets the active text editor's selection, or the visible content if the selected range is empty.
     */
    getActiveTextEditorSelectionOrVisibleContent(): ActiveTextEditorSelection | null
    /**
     * Get diagnostics (errors, warnings, hints) for a range within the active text editor.
     */
    getActiveTextEditorDiagnosticsForRange(range: ActiveTextEditorSelectionRange): ActiveTextEditorDiagnostic[] | null

    getActiveTextEditorVisibleContent(): ActiveTextEditorVisibleContent | null

    getTextEditorContentForFile(uri: URI, range?: ActiveTextEditorSelectionRange): Promise<string | undefined>

    replaceSelection(fileName: string, selectedText: string, replacement: string): Promise<void>
    showQuickPick(labels: string[]): Promise<string | undefined>
    showWarningMessage(message: string): Promise<void>
    showInputBox(prompt?: string): Promise<string | undefined>
}

export class NoopEditor implements Editor {
    public controllers?: ActiveTextEditorViewControllers<VsCodeCommandsController> | undefined

    public getWorkspaceRootPath(): string | null {
        return null
    }

    public getWorkspaceRootUri(): URI | null {
        return null
    }

    public getActiveTextEditor(): ActiveTextEditor | null {
        return null
    }

    public getActiveTextEditorSelection(): ActiveTextEditorSelection | null {
        return null
    }

    public getActiveTextEditorSmartSelection(): Promise<ActiveTextEditorSelection | null> {
        return Promise.resolve(null)
    }

    public getActiveTextEditorSelectionOrEntireFile(): ActiveTextEditorSelection | null {
        return null
    }

    public getActiveTextEditorSelectionOrVisibleContent(): ActiveTextEditorSelection | null {
        return null
    }

    public getActiveTextEditorDiagnosticsForRange(): ActiveTextEditorDiagnostic[] | null {
        return null
    }

    public getActiveTextEditorVisibleContent(): ActiveTextEditorVisibleContent | null {
        return null
    }

    public getTextEditorContentForFile(
        _uri: URI,
        _range?: ActiveTextEditorSelectionRange
    ): Promise<string | undefined> {
        return Promise.resolve(undefined)
    }

    public replaceSelection(_fileName: string, _selectedText: string, _replacement: string): Promise<void> {
        return Promise.resolve()
    }

    public showQuickPick(_labels: string[]): Promise<string | undefined> {
        return Promise.resolve(undefined)
    }

    public showWarningMessage(_message: string): Promise<void> {
        return Promise.resolve()
    }

    public showInputBox(_prompt?: string): Promise<string | undefined> {
        return Promise.resolve(undefined)
    }
}
