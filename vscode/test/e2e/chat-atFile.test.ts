import { expect } from '@playwright/test'

import { isWindows } from '@sourcegraph/cody-shared'

import { sidebarExplorer, sidebarSignin } from './common'
import { type ExpectedEvents, test, withPlatformSlashes } from './helpers'

// See chat-atFile.test.md for the expected behavior for this feature.
//
// NOTE: Creating new chats is slow, and setup is slow, so collapse these into fewer tests.

test.extend<ExpectedEvents>({
    expectedEvents: [
        'CodyInstalled',
        'CodyVSCodeExtension:at-mention:executed',
        'CodyVSCodeExtension:at-mention:file:executed',
    ],
})('@-mention file in chat', async ({ page, sidebar }) => {
    await sidebarSignin(page, sidebar)

    await page.getByRole('button', { name: 'New Chat', exact: true }).click()

    const chatPanelFrame = page.frameLocator('iframe.webview').last().frameLocator('iframe')

    const chatInput = chatPanelFrame.getByRole('textbox', { name: 'Chat message' })
    await chatInput.click()
    await page.keyboard.type('@')
    await expect(
        chatPanelFrame.getByRole('heading', {
            name: 'Search for a file to include, or type # for symbols...',
        })
    ).toBeVisible()
    await page.keyboard.press('Backspace')

    // No results
    await chatInput.fill('@definitelydoesntexist')
    await expect(chatPanelFrame.getByRole('heading', { name: 'No files found' })).toBeVisible()

    // Clear the input so the next test doesn't detect the same text already visible from the previous
    // check (otherwise the test can pass even without the filter working).
    await chatInput.clear()

    // We should only match the relative visible path, not parts of the full path outside of the workspace.
    // Eg. searching for "source" should not find all files if the project is inside `C:\Source`.
    // TODO(dantup): After https://github.com/sourcegraph/cody/pull/2235 lands, add workspacedirectory to the test
    //   and assert that it contains `fixtures` to ensure this check isn't passing because the fixture folder no
    //   longer matches.
    await chatInput.fill('@fixtures') // fixture is in the test project folder name, but not in the relative paths.
    await expect(chatPanelFrame.getByRole('heading', { name: 'No files found' })).toBeVisible()

    // Includes dotfiles after just "."
    await chatInput.fill('@.')
    await expect(chatPanelFrame.getByRole('option', { name: '.mydotfile' })).toBeVisible()

    // Forward slashes
    await chatInput.fill('@lib/batches/env')
    await expect(
        chatPanelFrame.getByRole('option', { name: withPlatformSlashes('lib/batches/env/var.go') })
    ).toBeVisible()

    // Backslashes
    if (isWindows()) {
        await chatInput.fill('@lib\\batches\\env')
        await expect(
            chatPanelFrame.getByRole('option', { name: withPlatformSlashes('lib/batches/env/var.go') })
        ).toBeVisible()
    }

    // Space before @ is required unless it's at position 0
    await chatInput.fill('Explain@mj')
    await expect(chatPanelFrame.getByRole('option', { name: 'Main.java' })).not.toBeVisible()
    await chatInput.fill('@mj')
    await expect(chatPanelFrame.getByRole('option', { name: 'Main.java' })).toBeVisible()
    await chatInput.fill('clear')

    // Searching and clicking
    await chatInput.fill('Explain @mj')
    await chatPanelFrame.getByRole('option', { name: 'Main.java' }).click()
    await expect(chatInput).toHaveText('Explain @Main.java ')
    await expect(chatInput.getByText('@Main.java')).toHaveClass(/context-item-mention-node/)
    await chatInput.press('Enter')
    await expect(chatInput).toBeEmpty()
    await expect(chatPanelFrame.getByText('Explain @Main.java')).toBeVisible()
    await expect(chatPanelFrame.getByText(/^✨ Context:/)).toHaveCount(1)
    await expect(chatInput).not.toHaveText('Explain @Main.java ')
    await expect(chatPanelFrame.getByRole('option', { name: 'Main.java' })).not.toBeVisible()

    // Keyboard nav through context files
    await chatInput.fill('Explain @var.go')
    await expect(
        chatPanelFrame.getByRole('option', { name: withPlatformSlashes('lib/batches/env/var.go') })
    ).toBeVisible()
    await chatInput.press('Tab')
    await expect(chatInput).toHaveText(withPlatformSlashes('Explain @lib/batches/env/var.go '))
    await chatInput.pressSequentially('and @visualize.go')
    await chatInput.press('ArrowDown') // second item (visualize.go)
    await chatInput.press('ArrowDown') // third item (.vscode/settings.json)
    await chatInput.press('ArrowDown') // wraps back to first item
    await chatInput.press('ArrowDown') // second item again
    await chatInput.press('Tab')
    await expect(chatInput).toHaveText(
        withPlatformSlashes(
            'Explain @lib/batches/env/var.go and @lib/codeintel/tools/lsif-visualize/visualize.go '
        )
    )

    // Send the message and check it was included
    await chatInput.press('Enter')
    await expect(chatInput).toBeEmpty()
    await expect(
        chatPanelFrame.getByText(
            withPlatformSlashes(
                'Explain @lib/batches/env/var.go and @lib/codeintel/tools/lsif-visualize/visualize.go'
            )
        )
    ).toBeVisible()

    // Ensure explicitly @-included context shows up as enhanced context
    await expect(chatPanelFrame.getByText(/^✨ Context:/)).toHaveCount(2)

    // Check pressing tab after typing a complete filename.
    // https://github.com/sourcegraph/cody/issues/2200
    await chatInput.focus()
    await chatInput.clear()
    await chatInput.pressSequentially('@Main.java')
    await expect(chatPanelFrame.getByRole('option', { name: 'Main.java' })).toBeVisible()
    await chatInput.press('Tab')
    await expect(chatInput).toHaveText('@Main.java ')

    // Check pressing tab after typing a partial filename but where that complete
    // filename already exists earlier in the input.
    // https://github.com/sourcegraph/cody/issues/2243
    await chatInput.pressSequentially('and @Main.ja', { delay: 50 })
    await chatInput.press('Tab')
    await expect(chatInput).toHaveText('@Main.java and @Main.java ')

    // Support @-file in mid-sentence
    await chatInput.focus()
    await chatInput.clear()
    await chatInput.fill('Explain the file')
    await chatInput.press('ArrowLeft') // 'Explain the fil|e'
    await chatInput.press('ArrowLeft') // 'Explain the fi|le'
    await chatInput.press('ArrowLeft') // 'Explain the f|ile'
    await chatInput.press('ArrowLeft') // 'Explain the |file'
    await chatInput.press('ArrowLeft') // 'Explain the| file'
    await chatInput.press('Space') // 'Explain the | file'
    await chatInput.pressSequentially('@Main')
    await expect(chatPanelFrame.getByRole('option', { name: 'Main.java' })).toBeVisible()
    await chatInput.press('Tab')
    await expect(chatInput).toHaveText('Explain the @Main.java file')
    // Confirm the cursor is at the end of the newly added file name with space
    await page.keyboard.press('!')
    await page.keyboard.press('Delete')
    await expect(chatInput).toHaveText('Explain the @Main.java !file')

    //  "ArrowLeft" / "ArrowRight" keys alter the query input for @-mentions.
    const noMatches = chatPanelFrame.getByRole('heading', { name: 'No files found' })
    await chatInput.pressSequentially(' @abcdefg')
    await expect(chatInput).toHaveText('Explain the @Main.java ! @abcdefgfile')
    await noMatches.hover()
    await expect(noMatches).toBeVisible()
    await chatInput.press('ArrowLeft')
    await expect(noMatches).toBeVisible()
    await chatInput.press('ArrowRight')
    await expect(noMatches).toBeVisible()
    await chatInput.press('?')
    await expect(chatInput).toHaveText('Explain the @Main.java ! @abcdefg?file')
    await expect(noMatches).not.toBeVisible()
    // Selection close on submit
    await chatInput.press('Enter')
    await expect(noMatches).not.toBeVisible()
    await expect(chatInput).toBeEmpty()

    // Query ends with non-alphanumeric character
    // with no results should not show selector.
    await chatInput.focus()
    await chatInput.fill('@unknown')
    await expect(noMatches).toBeVisible()
    await chatInput.press('?')
    await expect(chatInput).toHaveText('@unknown?')
    await expect(noMatches).not.toBeVisible()
    await chatInput.press('Backspace')
    await expect(noMatches).toBeVisible()
})

test('editing a chat message with @-mention', async ({ page, sidebar }) => {
    await sidebarSignin(page, sidebar)
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const chatPanelFrame = page.frameLocator('iframe.webview').last().frameLocator('iframe')
    const chatInput = chatPanelFrame.getByRole('textbox', { name: 'Chat message' })

    // Send a message with an @-mention.
    await chatInput.fill('Explain @mj')
    await chatPanelFrame.getByRole('option', { name: 'Main.java' }).click()
    await expect(chatInput).toHaveText('Explain @Main.java ')
    await expect(chatInput.getByText('@Main.java')).toHaveClass(/context-item-mention-node/)
    await chatInput.press('Enter')
    await expect(chatInput).toBeEmpty()
    await expect(chatPanelFrame.getByText('Explain @Main.java')).toBeVisible()
    await expect(chatPanelFrame.getByText(/^✨ Context: 1 file/)).toHaveCount(1)

    // Edit the just-sent message and resend it. Confirm it is sent with the right context items.
    await chatInput.press('ArrowUp')
    await expect(chatInput).toHaveText('Explain @Main.java ')
    await chatInput.press('Meta+Enter')
    await expect(chatPanelFrame.getByText(/^✨ Context: 1 file/)).toHaveCount(1)

    // Edit it again, add a new @-mention, and resend.
    await chatInput.press('ArrowUp')
    await expect(chatInput).toHaveText('Explain @Main.java ')
    await chatInput.pressSequentially('and @index.ht')
    await chatPanelFrame.getByRole('option', { name: 'index.html' }).click()
    await expect(chatInput).toHaveText('Explain @Main.java and @index.html')
    await expect(chatInput.getByText('@index.html')).toHaveClass(/context-item-mention-node/)
    await chatInput.press('Enter')
    await expect(chatInput).toBeEmpty()
    await expect(chatPanelFrame.getByText('Explain @Main.java and @index.html')).toBeVisible()
    await expect(chatPanelFrame.getByText(/^✨ Context: 2 files/)).toHaveCount(1)
})

test('typing @-mention text does not automatically accept it', async ({ page, sidebar }) => {
    await sidebarSignin(page, sidebar)
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const chatPanelFrame = page.frameLocator('iframe.webview').last().frameLocator('iframe')
    const chatInput = chatPanelFrame.getByRole('textbox', { name: 'Chat message' })

    // Typing out the whole file path without pressing tab/enter should NOT include the file as
    // context.
    await chatInput.fill('Explain @index.htm')
    await page.waitForTimeout(100)
    await chatInput.press('l')
    await expect(chatPanelFrame.getByRole('option', { name: 'index.html' })).toBeVisible()
    await chatInput.press('Space')
    await expect(chatPanelFrame.getByRole('option', { name: 'index.html' })).not.toBeVisible()
    await chatInput.press('Enter')
    await expect(chatPanelFrame.getByText(/^✨ Context:/)).toHaveCount(0)
})

test('pressing Enter with @-mention menu open selects item, does not submit message', async ({
    page,
    sidebar,
}) => {
    await sidebarSignin(page, sidebar)
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const chatPanelFrame = page.frameLocator('iframe.webview').last().frameLocator('iframe')
    const chatInput = chatPanelFrame.getByRole('textbox', { name: 'Chat message' })

    await chatInput.fill('Explain @index.htm')
    await expect(chatPanelFrame.getByRole('option', { name: 'index.html' })).toBeVisible()
    await chatInput.press('Enter')
    await expect(chatInput).toHaveText('Explain @index.html')
    await expect(chatInput.getByText('@index.html')).toHaveClass(/context-item-mention-node/)
})

test.extend<ExpectedEvents>({
    expectedEvents: [
        'CodyInstalled',
        'CodyVSCodeExtension:at-mention:executed',
        'CodyVSCodeExtension:at-mention:symbol:executed',
    ],
})('@-mention symbol in chat', async ({ page, sidebar }) => {
    await sidebarSignin(page, sidebar)

    // Open chat.
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const chatPanelFrame = page.frameLocator('iframe.webview').last().frameLocator('iframe')
    const chatInput = chatPanelFrame.getByRole('textbox', { name: 'Chat message' })

    // Open the buzz.ts file so that VS Code starts to populate symbols.
    await sidebarExplorer(page).click()
    await page.getByRole('treeitem', { name: 'buzz.ts' }).locator('a').dblclick()
    await page.getByRole('tab', { name: 'buzz.ts' }).hover()

    // Go back to the Cody chat tab
    await page.getByRole('tab', { name: 'New Chat' }).click()

    // Symbol empty state
    await chatInput.fill('@#')
    await expect(chatPanelFrame.getByRole('heading', { name: /No symbols found/ })).toBeVisible()

    // Clicking on a file in the selector should autocomplete the file in chat input with added space
    await chatInput.fill('@#fizzb')
    await expect(chatPanelFrame.getByRole('option', { name: 'fizzbuzz()' })).toBeVisible({
        // Longer timeout because sometimes tsserver takes a while to become ready.
        timeout: 15000,
    })
    await chatPanelFrame.getByRole('option', { name: 'fizzbuzz()' }).click()
    await expect(chatInput).toHaveText('@#fizzbuzz() ')

    // Submit the message
    await chatInput.press('Enter')

    // Close file.
    const pinnedTab = page.getByRole('tab', { name: 'buzz.ts' })
    await pinnedTab.getByRole('button', { name: /^Close/ }).click()

    // @-file with the correct line range shows up in the chat view and it opens on click
    await chatPanelFrame.getByText('✨ Context: 15 lines from 1 file').hover()
    await chatPanelFrame.getByText('✨ Context: 15 lines from 1 file').click()
    await chatPanelFrame.getByRole('button', { name: '@buzz.ts:1-15' }).hover()
    await chatPanelFrame.getByRole('button', { name: '@buzz.ts:1-15' }).click()
    const previewTab = page.getByRole('tab', { name: /buzz.ts, preview, Editor Group/ })
    await previewTab.hover()
    await expect(previewTab).toBeVisible()
})
