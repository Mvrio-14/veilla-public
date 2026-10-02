/**
 * Signal: watchers that read the stories of the reader's monitors and
 * decide, each against its own request, which ones to keep. The
 * interface calls them agents; the API and the database, watchers.
 *
 * The unit judged is a story moment: a story, as it stands when new
 * articles reach it. A watcher sees the story's label and synthesis, the
 * articles that are new since its last judgment of that story (within
 * its monitors), and the reason it gave if it already kept the story.
 * That bounds what a long story costs to judge, whatever its length.
 */

export type Watcher = {
  id: number;
  name: string;
  /** What the watcher is asked to keep, in the reader's own words. */
  request: string;
  status: "active" | "paused";
  /** The monitors whose stories it reads. Empty means all of them. */
  monitor_ids: number[];
  kept_7d: number;
  dropped_7d: number;
  last_kept_at: string | null;
  created_at: string;
  /** Live stories judged in the last 24 hours, against `daily_budget`. */
  judged_24h: number;
  /** Stories the budget could not reach while fresh, last 24 hours. */
  skipped_24h: number;
  daily_budget: number;
};

/** A watcher that is missing news: its budget is spent, or it skipped
 *  stories in the last day. */
export const overBudget = (w: Watcher) =>
  w.skipped_24h > 0 || w.judged_24h >= w.daily_budget;

export type Verdict = "kept" | "dropped";

/** Why a watcher did not judge a story moment: none of the story's
 *  articles comes from its monitors, its daily budget could not reach
 *  the story while it was fresh, or the story is waiting for a pass. */
export type NotJudgedReason = "out_of_scope" | "budget" | "pending";

export type MomentArticle = {
  title: string;
  source: string;
  url: string;
};

/** Exactly what the watcher was given, so a verdict can be checked
 *  against it rather than guessed at. */
export type DecisionInput = {
  label: string;
  synthesis: string;
  articles: MomentArticle[];
  /** The reason of its last "kept" on this story, if any. */
  already_kept: string | null;
};

export type Decision = {
  watcher_id: number;
  verdict: Verdict;
  /** One sentence. */
  reason: string;
  /** The passage of an article the verdict rests on, when there is one. */
  excerpt: string | null;
  input: DecisionInput;
  model: string;
  input_tokens: number;
  output_tokens: number;
  decided_at: string;
};

export type StoryMoment = {
  id: number;
  story_id: number;
  label: string;
  at: string;
  articles: MomentArticle[];
  decisions: Decision[];
  not_judged: { watcher_id: number; reason: NotJudgedReason }[];
};

export type ReadingContext = {
  body: string;
  updated_at: string | null;
};
