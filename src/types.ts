export interface ParsedChat {
  session_id: string;
  project_dir: string;
  jsonl_path: string;
  started_at: number;
  ended_at: number;
  last_active_at: number;
  message_count: number;
  activity: Record<string, number>; // localDay -> user-message count
  files_touched: string[];
  first_message: string;
  claude_auto_title: string;
  pr_url: string;
}

// Whose-court state of a chat, used for color-coded triage on the dashboard.
//   done          -> green  (finished, nothing left for the user to do)
//   waiting_on_user -> blue (Claude asked a question / needs your input or decision)
//   warning       -> yellow (completed but with caveats / unresolved non-blocking items)
//   error         -> red    (hit an unresolved error, failure, or is blocked)
export type ChatState = 'done' | 'waiting_on_user' | 'warning' | 'error';

export const CHAT_STATES: readonly ChatState[] = ['done', 'waiting_on_user', 'warning', 'error'];

export interface Summary {
  title: string;
  overview: string;
  state: ChatState;
  breakdown: string[]; // "key moments"
}

// Stored row shape (as read back from SQLite).
export interface ChatRow {
  session_id: string;
  project_dir: string;
  jsonl_path: string;
  started_at: number;
  ended_at: number;
  last_active_at: number;
  message_count: number;
  activity_json: string;
  files_touched: string;
  first_message: string;
  claude_auto_title: string;
  pr_url: string;
  title: string;
  overview: string;
  state: string;
  breakdown_json: string;
  summary_dirty: number;
  summary_model: string;
  summary_at: number;
  last_tmux_session: string;
  last_pane_id: string;
  saved: number;
  saved_at: number;
  jsonl_mtime: number;
  last_indexed_at: number;
}
