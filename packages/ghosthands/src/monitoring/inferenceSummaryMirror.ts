import fs from 'node:fs';
import path from 'node:path';
import { getActiveJobActSummaryPath } from './logger.js';

const SOURCE_PATH = path.resolve(
  process.cwd(),
  'inference_summary',
  'act_summary',
  'act_summary.json',
);

let mirrorInitialized = false;

export function startInferenceSummaryMirror(): void {
  if (mirrorInitialized) return;
  mirrorInitialized = true;

  const target = process.env.GH_ACT_SUMMARY_MIRROR_PATH?.trim();
  if (!target) return;

  const targetPath = path.resolve(target);
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let lastMirroredMtimeMs = 0;
  let hasAnnouncedTarget = false;
  let lastAnnouncedActiveJobPath = '';
  let lastMirroredActiveJobPath = '';

  const syncSummary = () => {
    if (!fs.existsSync(SOURCE_PATH)) return;
    const stat = fs.statSync(SOURCE_PATH);
    const activeJobSummaryPath = getActiveJobActSummaryPath();
    const shouldMirrorForActiveJob =
      Boolean(activeJobSummaryPath) &&
      activeJobSummaryPath !== lastMirroredActiveJobPath;
    if (stat.mtimeMs <= lastMirroredMtimeMs && !shouldMirrorForActiveJob) return;

    fs.copyFileSync(SOURCE_PATH, targetPath);
    if (activeJobSummaryPath) {
      const activeDir = path.dirname(activeJobSummaryPath);
      if (!fs.existsSync(activeDir)) {
        fs.mkdirSync(activeDir, { recursive: true });
      }
      fs.copyFileSync(SOURCE_PATH, activeJobSummaryPath);
      lastMirroredActiveJobPath = activeJobSummaryPath;
    }
    const rawSummary = fs.readFileSync(SOURCE_PATH, 'utf8');
    lastMirroredMtimeMs = stat.mtimeMs;

    if (!hasAnnouncedTarget) {
      console.log(`[logger] Mirroring action summary to: ${targetPath}`);
      hasAnnouncedTarget = true;
    }
    if (activeJobSummaryPath && activeJobSummaryPath !== lastAnnouncedActiveJobPath) {
      console.log(`[logger] Mirroring action summary to active job path: ${activeJobSummaryPath}`);
      lastAnnouncedActiveJobPath = activeJobSummaryPath;
    }

    console.log(
      [
        `[action-summary][start] path=${targetPath}`,
        rawSummary,
        '[action-summary][end]',
      ].join('\n'),
    );
  };

  try {
    syncSummary();
  } catch (error) {
    console.warn(
      `[action-summary] Initial mirror failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  fs.watchFile(SOURCE_PATH, { interval: 1000 }, () => {
    try {
      syncSummary();
    } catch (error) {
      console.warn(
        `[action-summary] Mirror failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  process.on('exit', () => {
    fs.unwatchFile(SOURCE_PATH);
  });
}
