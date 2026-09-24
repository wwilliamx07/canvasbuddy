import '@fontsource-variable/fraunces';
import '@fontsource-variable/inter';
import './theme.css';

import { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Brain, ChevronDown, Settings as SettingsIcon } from 'lucide-react';
import type { ShellProps } from './model';
import { ChatArea, ChatListPopover } from './Chat';
import { CheckingPlaceholder, ConnectScreen } from './Connect';
import { MemorySheet } from './Memory';
import { SettingsSheet } from './Settings';
import { IconButton, Logo } from './primitives';

type SheetName = 'memory' | 'settings' | null;

export function Shell({ model }: ShellProps) {
  const [sheet, setSheet] = useState<SheetName>(null);
  const [chatListOpen, setChatListOpen] = useState(false);

  const currentTitle = model.chats.find((c) => c.id === model.currentChatId)?.title ?? 'New chat';

  let main;
  if (model.connection.status === 'checking') {
    main = <CheckingPlaceholder host={model.connection.host} />;
  } else if (model.connection.status === 'disconnected') {
    main = <ConnectScreen model={model} />;
  } else {
    main = <ChatArea model={model} />;
  }

  return (
    <div className="app relative flex h-full w-full flex-col overflow-hidden bg-(--bg) text-(--ink)">
      <header className="relative z-10 flex h-12 shrink-0 items-center gap-1 border-b border-(--line) px-2.5">
        <Logo size={26} className="ml-1 mr-0.5" />
        <button
          type="button"
          onClick={() => setChatListOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-(--bg-sunken)"
        >
          <span className="serif truncate text-[14px] font-medium text-(--ink)">{currentTitle}</span>
          <ChevronDown size={13} className="shrink-0 text-(--ink-mute)" />
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton icon={Brain} label="Memory" onClick={() => setSheet('memory')} active={sheet === 'memory'} />
          <IconButton icon={SettingsIcon} label="Settings" onClick={() => setSheet('settings')} active={sheet === 'settings'} />
        </div>
      </header>

      {model.notice && (
        <div className="flex items-center justify-between gap-2 border-b border-(--line) bg-(--warn-soft) px-3 py-1.5 text-[12px] text-(--warn)">
          <span className="min-w-0 flex-1">{model.notice.text}</span>
          {model.notice.reload && (
            <button type="button" onClick={model.reload} className="shrink-0 rounded-full border border-(--warn) px-2 py-0.5 text-[11px] hover:bg-(--bg)">
              Reload
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {main}
        <AnimatePresence>
          {chatListOpen && (
            <ChatListPopover
              chats={model.chats}
              currentChatId={model.currentChatId}
              onSelect={model.selectChat}
              onDelete={model.deleteChat}
              onNew={model.newChat}
              onClose={() => setChatListOpen(false)}
            />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>{sheet === 'memory' && <MemorySheet memory={model.memory} onClose={() => setSheet(null)} />}</AnimatePresence>
      <AnimatePresence>{sheet === 'settings' && <SettingsSheet model={model} onClose={() => setSheet(null)} />}</AnimatePresence>
    </div>
  );
}
