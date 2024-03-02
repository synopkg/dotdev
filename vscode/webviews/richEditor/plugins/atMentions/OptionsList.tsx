import type { MenuRenderFn } from '@lexical/react/LexicalTypeaheadMenuPlugin'
import { displayPath } from '@sourcegraph/cody-shared'
import classNames from 'classnames'
import type React from 'react'
import { useEffect, useRef } from 'react'
import styles from './OptionsList.module.css'
import type { MentionTypeaheadOption } from './atMentions'

export const OptionsList: React.FunctionComponent<
    { query: string; options: MentionTypeaheadOption[] } & Pick<
        Parameters<MenuRenderFn<MentionTypeaheadOption>>[1],
        'selectedIndex' | 'setHighlightedIndex' | 'selectOptionAndCleanUp'
    >
> = ({ query, options, selectedIndex, setHighlightedIndex, selectOptionAndCleanUp }) => {
    const ref = useRef<HTMLUListElement>(null)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Intent is to run whenever `options` changes.
    useEffect(() => {
        // Scroll to top when options change because the prior `selectedIndex` is invalidated.
        ref?.current?.scrollTo(0, 0)
        setHighlightedIndex(0)
    }, [options])

    return (
        <div className={styles.container}>
            <aside role="note" className={classNames(styles.item, styles.helpItem)}>
                {query === ''
                    ? 'Search for a file to include, or type # for symbols...'
                    : query.startsWith('#')
                      ? options.length > 0
                            ? 'Search for a symbol to include...'
                            : `No symbols found${
                                  query.length <= 2
                                      ? ' (check if language extensions are installed)'
                                      : ''
                              }`
                      : options.length > 0
                          ? 'Search for a file to include...'
                          : 'No files found'}
            </aside>
            <ul ref={ref} className={styles.list}>
                {options.map((option, i) => (
                    <Item
                        index={i}
                        isSelected={selectedIndex === i}
                        onClick={() => {
                            setHighlightedIndex(i)
                            selectOptionAndCleanUp(option)
                        }}
                        onMouseEnter={() => {
                            setHighlightedIndex(i)
                        }}
                        key={option.key}
                        option={option}
                        className={styles.item}
                    />
                ))}
            </ul>
        </div>
    )
}

const Item: React.FunctionComponent<{
    index: number
    isSelected: boolean
    onClick: () => void
    onMouseEnter: () => void
    option: MentionTypeaheadOption
    className?: string
}> = ({ index, isSelected, onClick, onMouseEnter, option, className }) => {
    const item = option.item
    const icon =
        item.type === 'file' ? null : item.kind === 'class' ? 'symbol-structure' : 'symbol-method'
    const title = item.type === 'file' ? displayPath(item.uri) : item.symbolName
    const range = item.range ? `:${item.range.start.line + 1}-${item.range.end.line + 1}` : ''
    const description = item.type === 'file' ? undefined : displayPath(item.uri) + range
    const warning =
        item.type === 'file' && item.title === 'large-file'
            ? 'File too large. Type @# to choose a symbol.'
            : undefined

    return (
        // biome-ignore lint/a11y/useKeyWithClickEvents:
        <li
            key={option.key}
            tabIndex={-1}
            className={classNames(className, styles.optionItem, isSelected && styles.selected)}
            ref={option.setRefElement}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: This element is interactive, in a dropdown list.
            role="option"
            aria-selected={isSelected}
            onMouseEnter={onMouseEnter}
            onClick={onClick}
        >
            {item.type === 'symbol' && icon && (
                <i className={`codicon codicon-${icon}`} title={item.kind} />
            )}
            <span
                className={classNames(
                    styles.optionItemTitle,
                    warning && styles.optionItemTitleWithWarning
                )}
            >
                {title}
            </span>
            {description && <span className={styles.optionItemDescription}>{description}</span>}
            {warning && <span className={styles.optionItemWarning}>{warning}</span>}
        </li>
    )
}
