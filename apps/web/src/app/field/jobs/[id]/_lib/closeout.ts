/*
 * Shared type + the sessionStorage handoff key between /voice and /done —
 * same pattern as ../_lib/prep.ts's /prep -> /prep-result handoff. /voice
 * collects the technician's close-out data (transcript, optional voice-note
 * file key, first_time_fix); /done is the one that actually enqueues the
 * closeout.submit mutation (this stage's task 5 says "on mount or confirm"
 * — this build does it on mount, reading what /voice handed off), so the
 * data has to cross the real route boundary the same local-only way /prep's
 * answers do.
 */

export type CloseoutHandoff = {
  first_time_fix: boolean;
  technician_note_transcript: string;
  technician_voice_note_file?: string;
};

export function closeoutStorageKey(jobId: string): string {
  return `fr:closeout:${jobId}`;
}
