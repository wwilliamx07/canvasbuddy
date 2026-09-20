import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  File as FileIcon,
  FileText,
  Folder,
  HelpCircle,
  Link2,
  Megaphone,
  MessagesSquare,
  Minus,
  Puzzle,
  ScrollText,
  Trash2,
} from 'lucide-react';
import type {
  AnnouncementRow,
  AssignmentRow,
  Chunk,
  CourseMemory,
  CourseSummary,
  DiscussionRow,
  FileRow,
  MemoryModel,
  MemoryNode,
  ModuleItemNode,
  ModuleItemType,
  ModuleNode,
  PageRow,
  QuizRow,
} from './model';
import { formatBytes, formatDue, syncPill, timeAgo } from './format';
import { EmptyState, Pill, Sheet, Spinner, StatusLine } from './primitives';

function sameNode(a: MemoryNode, b: MemoryNode | null): boolean {
  if (!b || a.node_type !== b.node_type) return false;
  if (a.node_type === 'module' && b.node_type === 'module') return a.node_id === b.node_id;
  if (a.node_type === 'module_item' && b.node_type === 'module_item') return a.node_id === b.node_id;
  if (a.node_type === 'assignment' && b.node_type === 'assignment') return a.assignment_id === b.assignment_id;
  if (a.node_type === 'page' && b.node_type === 'page') return a.page_url === b.page_url;
  if (a.node_type === 'file' && b.node_type === 'file') return a.file_id === b.file_id;
  return false;
}

const ITEM_ICONS: Record<ModuleItemType, typeof FileText> = {
  File: FileText,
  Page: BookMarked,
  Assignment: ClipboardList,
  Discussion: MessagesSquare,
  Quiz: HelpCircle,
  ExternalUrl: Link2,
  ExternalTool: Puzzle,
  SubHeader: Minus,
};

function nodeInfo(node: MemoryNode): { name: string; type: string; id: string; htmlUrl: string | null; due?: string | null; points?: number | null } {
  switch (node.node_type) {
    case 'module':
      return { name: node.label, type: 'Module', id: node.node_id, htmlUrl: null };
    case 'module_item':
      return { name: node.label, type: node.item_type, id: node.content_ref ?? node.node_id, htmlUrl: node.html_url };
    case 'assignment':
      return { name: node.name, type: 'Assignment', id: node.assignment_id, htmlUrl: node.html_url, due: node.due_at, points: node.points_possible };
    case 'page':
      return { name: node.title, type: 'Page', id: node.page_url, htmlUrl: node.html_url };
    case 'file':
      return { name: node.display_name, type: 'File', id: node.file_id, htmlUrl: node.html_url };
  }
}

function ChunkPreview({ chunks }: { chunks: Chunk[] }) {
  return (
    <ul className="space-y-2">
      {chunks.map((c) => (
        <li key={c.chunk_id} className="rounded-lg border border-(--line) bg-(--bg-sunken) px-2.5 py-2">
          <div className="mb-1 text-[10.5px] text-(--ink-mute)">
            chunk {c.chunk_index}
            {c.page_number != null && <> · page {c.page_end && c.page_end !== c.page_number ? `${c.page_number}–${c.page_end}` : c.page_number}</>}
          </div>
          <p className="line-clamp-2 text-[12px] text-(--ink-soft)">{c.content}</p>
        </li>
      ))}
    </ul>
  );
}

function Inspector({ node, memory }: { node: MemoryNode; memory: MemoryModel }) {
  const info = nodeInfo(node);
  const indexed = node.node_type !== 'module' && node.indexed;
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18 }}
      className="overflow-hidden"
    >
      <div className="mb-3 ml-1 space-y-2 border-l-2 border-(--accent-soft-strong) py-1 pl-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-(--ink-mute)">
          <span className="rounded-full bg-(--bg-sunken) px-2 py-0.5">{info.type}</span>
          <span className="font-mono text-[11px]">{info.id}</span>
          {info.due !== undefined && <span>due {formatDue(info.due ?? null)}</span>}
          {info.points != null && <span>{info.points} pts</span>}
        </div>
        {info.htmlUrl && (
          <a href={info.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-(--accent) hover:underline">
            View in Canvas <ExternalLink size={11} />
          </a>
        )}
        {memory.selectedIsIndexable && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <span className="text-[11.5px] text-(--ink-mute)">{indexed ? `Text remembered (${memory.nodeChunks.length} chunks)` : 'Text not read yet'}</span>
              {indexed && (
                <button
                  type="button"
                  disabled={memory.isForgetting}
                  onClick={memory.forgetSelected}
                  className="inline-flex items-center gap-1 rounded-full border border-(--line) px-2.5 py-0.5 text-[11.5px] text-(--ink-soft) hover:bg-(--error-soft) hover:text-(--error) disabled:opacity-60"
                >
                  <Trash2 size={11} /> Forget text
                </button>
              )}
            </div>
            {memory.nodeChunks.length > 0 && <ChunkPreview chunks={memory.nodeChunks} />}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function SelectableRow({
  node,
  memory,
  icon: Icon,
  label,
  meta,
}: {
  node: MemoryNode;
  memory: MemoryModel;
  icon: typeof FileText;
  label: string;
  meta?: string;
}) {
  const selected = sameNode(node, memory.selectedNode);
  const indexed = node.node_type !== 'module' && node.indexed;
  return (
    <div>
      <button
        type="button"
        onClick={() => memory.selectNode(selected ? null : node)}
        className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-(--bg-sunken) ${selected ? 'bg-(--accent-soft)' : ''}`}
      >
        <Icon size={14} className="shrink-0 text-(--ink-mute)" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-(--ink)">{label}</span>
        {indexed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--accent)" title="Indexed" />}
        {meta && <span className="shrink-0 text-[11px] text-(--ink-mute)">{meta}</span>}
        <ChevronRight size={13} className={`shrink-0 text-(--ink-mute) transition-transform ${selected ? 'rotate-90' : ''}`} />
      </button>
      <AnimatePresence>{selected && <Inspector node={node} memory={memory} />}</AnimatePresence>
    </div>
  );
}

function Module({ module: m, memory }: { module: ModuleNode; memory: MemoryModel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-(--line) last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 py-2 text-left hover:bg-(--bg-sunken)">
        <ChevronDown size={14} className={`shrink-0 text-(--ink-mute) transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-(--ink)">{m.label}</span>
        <span className="shrink-0 text-[11px] text-(--ink-mute)">{m.items.length} {m.items.length === 1 ? 'item' : 'items'}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="pb-2 pl-4">
              {m.items.length === 0 ? (
                <p className="py-1 text-[12px] text-(--ink-mute)">No items in this module.</p>
              ) : (
                m.items.map((item: ModuleItemNode) => (
                  <SelectableRow key={item.node_id} node={item} memory={memory} icon={ITEM_ICONS[item.item_type]} label={item.label} />
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="border-t border-(--line) py-3 first:border-0 first:pt-0">
      <div className="mb-1.5 flex items-baseline justify-between">
        <h4 className="serif text-[13.5px] font-medium text-(--ink)">{title}</h4>
        {count != null && <span className="text-[11px] text-(--ink-mute)">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function AssignmentItem({ a, memory }: { a: AssignmentRow; memory: MemoryModel }) {
  const meta = [formatDue(a.due_at), a.points_possible != null ? `${a.points_possible} pts` : null, a.submission_state ?? undefined, a.score != null ? `${a.score}` : null]
    .filter(Boolean)
    .join(' · ');
  return <SelectableRow node={a} memory={memory} icon={ClipboardList} label={a.name} meta={meta} />;
}

function PageItem({ p, memory }: { p: PageRow; memory: MemoryModel }) {
  return <SelectableRow node={p} memory={memory} icon={BookMarked} label={p.front_page ? `${p.title} (front page)` : p.title} />;
}

function FileItem({ f, memory }: { f: FileRow; memory: MemoryModel }) {
  return <SelectableRow node={f} memory={memory} icon={FileIcon} label={f.display_name} meta={formatBytes(f.size)} />;
}

function AnnouncementItem({ a }: { a: AnnouncementRow }) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1.5">
      <Megaphone size={14} className="shrink-0 text-(--ink-mute)" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-(--ink)">{a.title}</span>
      <span className="shrink-0 text-[11px] text-(--ink-mute)">{a.posted_at ? timeAgo(a.posted_at) : ''}</span>
    </div>
  );
}

function DiscussionItem({ d }: { d: DiscussionRow }) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1.5">
      <MessagesSquare size={14} className="shrink-0 text-(--ink-mute)" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-(--ink)">{d.title}</span>
      <span className="shrink-0 text-[11px] text-(--ink-mute)">{d.reply_count} replies{!d.replies_read ? ' · unread' : ''}</span>
    </div>
  );
}

function QuizItem({ q }: { q: QuizRow }) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1.5">
      <HelpCircle size={14} className="shrink-0 text-(--ink-mute)" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-(--ink)">{q.title}</span>
      <span className="shrink-0 text-[11px] text-(--ink-mute)">
        {formatDue(q.due_at)}
        {q.points_possible != null ? ` · ${q.points_possible} pts` : ''}
      </span>
    </div>
  );
}

function CollectionsTable({ collections, memory }: { collections: CourseMemory['collections']; memory: MemoryModel }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-(--line)">
      <table className="w-full min-w-[280px] text-[12.5px]">
        <tbody>
          {collections.map((c) => {
            const pill = syncPill(c);
            return (
              <tr key={c.kind} className="border-t border-(--line) first:border-0">
                <td className="py-1.5 pl-2.5 text-(--ink)">{c.label}</td>
                <td className="py-1.5 text-right text-(--ink-mute)">{c.count != null ? c.count : ''}</td>
                <td className="py-1.5 pl-2 text-right">
                  <Pill label={pill.label} tone={pill.tone} />
                </td>
                <td className="w-7 py-1.5 pr-1.5 text-right">
                  {c.status !== 'never' && (
                    <button
                      type="button"
                      aria-label={`Forget ${c.label.toLowerCase()}`}
                      title={`Forget ${c.label.toLowerCase()}`}
                      disabled={memory.isForgetting}
                      onClick={() => memory.forgetCollection(c.kind)}
                      className="rounded-full p-1 text-(--ink-mute) hover:bg-(--error-soft) hover:text-(--error) disabled:opacity-40"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CourseDetail({ memory }: { memory: MemoryModel }) {
  const { course, loadingCourse, loadError } = memory;
  if (loadingCourse) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-(--ink-mute)">
        <Spinner size={16} /> Loading…
      </div>
    );
  }
  if (loadError) {
    return <EmptyState icon={Folder} title="Couldn't load this course" hint={loadError} />;
  }
  if (!course) return null;

  const nothing = course.modules.length === 0 && course.assignments.length === 0 && course.looseFiles.length === 0 && course.announcements.length === 0;

  return (
    <div className="px-4 py-4">
      <div className="mb-4">
        <div className="text-[13px] text-(--ink-soft)">{course.course.name}</div>
        <div className="text-[11.5px] text-(--ink-mute)">{course.course.term}</div>
      </div>

      <CollectionsTable collections={course.collections} memory={memory} />

      {nothing ? (
        <div className="pt-2">
          <EmptyState icon={Folder} title="Nothing remembered here yet" hint="Ask about this course in Chat; what the assistant reads is remembered here." />
        </div>
      ) : (
        <>
          <Section title="Modules" count={course.modules.length}>
            {course.modules.length === 0 ? (
              <p className="py-1 text-[12px] text-(--ink-mute)">No modules yet.</p>
            ) : (
              <div>
                {course.modules.map((m) => (
                  <Module key={m.node_id} module={m} memory={memory} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Assignments" count={course.assignments.length}>
            {course.assignments.length === 0 ? (
              <p className="py-1 text-[12px] text-(--ink-mute)">No assignments.</p>
            ) : (
              course.assignments.map((a) => <AssignmentItem key={a.assignment_id} a={a} memory={memory} />)
            )}
          </Section>

          <Section title="Pages" count={course.pages.length}>
            {course.pages.length === 0 ? <p className="py-1 text-[12px] text-(--ink-mute)">No pages.</p> : course.pages.map((p) => <PageItem key={p.page_url} p={p} memory={memory} />)}
          </Section>

          <Section title="Files" count={course.looseFiles.length}>
            {course.looseFiles.length === 0 ? (
              <p className="py-1 text-[12px] text-(--ink-mute)">No files outside a module.</p>
            ) : (
              course.looseFiles.map((f) => <FileItem key={f.file_id} f={f} memory={memory} />)
            )}
          </Section>

          <Section title="Announcements" count={course.announcements.length}>
            {course.announcements.length === 0 ? (
              <p className="py-1 text-[12px] text-(--ink-mute)">No announcements.</p>
            ) : (
              course.announcements.map((a) => <AnnouncementItem key={a.announcement_id} a={a} />)
            )}
          </Section>

          <Section title="Discussions" count={course.discussions.length}>
            {course.discussions.length === 0 ? (
              <p className="py-1 text-[12px] text-(--ink-mute)">No discussions.</p>
            ) : (
              course.discussions.map((d) => <DiscussionItem key={d.discussion_id} d={d} />)
            )}
          </Section>

          <Section title="Quizzes" count={course.quizzes.length}>
            {course.quizzes.length === 0 ? <p className="py-1 text-[12px] text-(--ink-mute)">No quizzes.</p> : course.quizzes.map((q) => <QuizItem key={q.quiz_id} q={q} />)}
          </Section>

          <Section title="Syllabus">
            <div className="flex items-center gap-2 px-1.5 py-1">
              <ScrollText size={14} className="shrink-0 text-(--ink-mute)" />
              <span className="text-[13px] text-(--ink)">Syllabus</span>
              <Pill label={course.hasSyllabus ? 'remembered' : 'not yet'} tone={course.hasSyllabus ? 'ok' : 'muted'} />
            </div>
          </Section>
        </>
      )}

      <div className="mt-6 flex justify-center border-t border-(--line) pt-4">
        <button
          type="button"
          disabled={memory.isForgetting}
          onClick={memory.forgetCourse}
          className="inline-flex items-center gap-1.5 rounded-full border border-(--line) px-3 py-1.5 text-[12.5px] text-(--error) hover:bg-(--error-soft) disabled:opacity-60"
        >
          <Trash2 size={12} /> Forget this course
        </button>
      </div>
    </div>
  );
}

function CourseCard({ course, onSelect }: { course: CourseSummary; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className="flex w-full flex-col gap-1 rounded-xl border border-(--line) bg-(--bg-raised) px-3.5 py-3 text-left hover:border-(--line-strong)">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-(--accent)">{course.course_code ?? '—'}</span>
        <span className="text-[11px] text-(--ink-mute)">{course.term}</span>
      </div>
      <div className="serif text-[14.5px] text-(--ink)">{course.name}</div>
      <div className="text-[11.5px] text-(--ink-mute)">
        {course.module_count} modules · {course.assignment_count} assignments · {course.indexed_document_count} indexed
      </div>
    </button>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-(--line) bg-(--bg-raised) px-2 py-1.5 text-center">
      <div className="serif text-[15px] text-(--ink)">{value}</div>
      <div className="text-[10px] text-(--ink-mute)">{label}</div>
    </div>
  );
}

function CourseList({ memory }: { memory: MemoryModel }) {
  const { stats, courses } = memory;
  return (
    <div className="px-4 py-4">
      <div className="mb-4 grid grid-cols-3 gap-2">
        <StatTile label="courses" value={stats.courseCount} />
        <StatTile label="modules" value={stats.moduleCount} />
        <StatTile label="items" value={stats.itemCount} />
        <StatTile label="assignments" value={stats.assignmentCount} />
        <StatTile label="files" value={stats.fileCount} />
        <StatTile label="indexed chunks" value={stats.chunkCount} />
      </div>

      {courses.length === 0 ? (
        <EmptyState icon={Folder} title="Nothing remembered yet" hint="Memory fills as you chat: courses, modules and documents the assistant reads are kept here." />
      ) : (
        <div className="space-y-2">
          {courses.map((c) => (
            <CourseCard key={c.course_id} course={c} onSelect={() => memory.selectCourse(c.course_id)} />
          ))}
        </div>
      )}

      {courses.length > 0 && (
        <div className="mt-6 flex justify-center border-t border-(--line) pt-4">
          <button
            type="button"
            disabled={memory.isForgetting}
            onClick={memory.forgetEverything}
            className="inline-flex items-center gap-1.5 rounded-full border border-(--line) px-3 py-1.5 text-[12.5px] text-(--error) hover:bg-(--error-soft) disabled:opacity-60"
          >
            <Trash2 size={12} /> Forget everything
          </button>
        </div>
      )}
    </div>
  );
}

export function MemorySheet({ memory, onClose }: { memory: MemoryModel; onClose: () => void }) {
  const detail = memory.selectedCourseId != null;
  const title = detail ? (memory.course?.course.course_code ?? 'Course') : 'Memory';

  return (
    <Sheet
      title={title}
      onBack={detail ? () => memory.selectCourse(null) : undefined}
      onClose={onClose}
    >
      <div className="relative min-h-full">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={detail ? 'detail' : 'list'}
            initial={{ opacity: 0, x: detail ? 16 : -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: detail ? -16 : 16 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {detail ? <CourseDetail memory={memory} /> : <CourseList memory={memory} />}
          </motion.div>
        </AnimatePresence>
        <StatusLine message={memory.statusMessage} />
      </div>
    </Sheet>
  );
}
