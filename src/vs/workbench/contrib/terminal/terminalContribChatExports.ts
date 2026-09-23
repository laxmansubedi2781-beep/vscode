/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// HACK: Export some chat-specific symbols from `terminalContrib/` that are depended upon elsewhere.
// These are soft layer breakers between `terminal/` and `terminalContrib/` but there are
// difficulties in removing the dependency. These are explicitly defined here to avoid an eslint
// line override.
export { MENU_CHAT_TERMINAL_TOOL_PROGRESS, TerminalChatContextKeys } from '../terminalContrib/chat/browser/terminalChat.js';

// The same hack, for the same reason, on behalf of the CloudeIDE panel: its
// agent runs commands in a real terminal, and running one properly — knowing
// where the command started and ended, and what it exited with — is machinery
// `terminalContrib/chatAgentTools` already owns. Writing a second copy of it
// in `contrib/cloudeide` would be a worse layer break than this line.
export { ToolTerminalCreator, ShellIntegrationQuality, type IToolTerminal } from '../terminalContrib/chatAgentTools/browser/toolTerminalCreator.js';
export type { ITerminalExecuteStrategy } from '../terminalContrib/chatAgentTools/browser/executeStrategy/executeStrategy.js';
export { RichExecuteStrategy } from '../terminalContrib/chatAgentTools/browser/executeStrategy/richExecuteStrategy.js';
export { BasicExecuteStrategy } from '../terminalContrib/chatAgentTools/browser/executeStrategy/basicExecuteStrategy.js';
export { NoneExecuteStrategy } from '../terminalContrib/chatAgentTools/browser/executeStrategy/noneExecuteStrategy.js';
