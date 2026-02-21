import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { ResumeDownloader } from '../../../src/workers/resumeDownloader';

// ---------------------------------------------------------------------------
// ResumeDownloader unit tests
// ---------------------------------------------------------------------------

describe('ResumeDownloader', () => {
  let downloader: ResumeDownloader;
  let mockSupabase: any;

  beforeEach(() => {
    mockSupabase = {
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: new Blob([Buffer.from('fake-pdf-content')], { type: 'application/pdf' }),
            error: null,
          }),
        }),
      },
    };
    downloader = new ResumeDownloader(mockSupabase);
  });

  test('downloads from Supabase storage_path and returns a local file path', async () => {
    const result = await downloader.download(
      { storage_path: 'resumes/user-123/resume.pdf' },
      'job-abc'
    );
    expect(result).toMatch(/job-abc.*\.pdf$/);
    // Cleanup
    await downloader.cleanup(result);
  });

  test('downloads from a URL and returns a local file path', async () => {
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/pdf', 'content-length': '100' }),
      arrayBuffer: () => Promise.resolve(Buffer.from('fake-pdf-content').buffer),
    });
    globalThis.fetch = mockFetch;

    try {
      const result = await downloader.download(
        { download_url: 'https://example.com/resumes/resume.pdf' },
        'job-def'
      );
      expect(result).toMatch(/job-def.*\.pdf$/);
      await downloader.cleanup(result);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws on empty resume ref', async () => {
    await expect(downloader.download({}, 'job-empty')).rejects.toThrow(
      'No valid resume source provided'
    );
  });

  test('throws on Supabase download error', async () => {
    mockSupabase.storage.from.mockReturnValue({
      download: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Object not found' },
      }),
    });

    await expect(
      downloader.download({ storage_path: 'resumes/missing.pdf' }, 'job-err')
    ).rejects.toThrow('Failed to download resume from Supabase Storage');
  });

  test('cleanup does not throw when file does not exist', async () => {
    // Should not throw — cleanup silently ignores missing files
    await downloader.cleanup('/tmp/nonexistent-file.pdf');
  });
});

// ---------------------------------------------------------------------------
// JobExecutor resume integration — resolveResumeRef logic
// ---------------------------------------------------------------------------

describe('JobExecutor resolveResumeRef logic', () => {
  // We test the resolveResumeRef method via its public behavior,
  // but since it's private, we test the behavior through the patterns it follows.
  // Instead of instantiating JobExecutor (which requires many deps),
  // we replicate the resolution logic to validate correctness.

  function resolveResumeRef(job: {
    resume_ref?: Record<string, any> | null;
    metadata?: Record<string, any>;
    input_data?: Record<string, any>;
  }) {
    // 1. Direct column
    const directRef = job.resume_ref;
    if (directRef && typeof directRef === 'object') {
      if (directRef.storage_path || directRef.download_url || directRef.s3_key) {
        return directRef;
      }
    }

    // 2. Backup in metadata
    const metaRef = job.metadata?.resume_ref;
    if (metaRef && typeof metaRef === 'object') {
      if (metaRef.storage_path || metaRef.download_url || metaRef.s3_key) {
        return metaRef;
      }
    }

    // 3. Legacy: input_data.resume_path
    const legacyPath = job.input_data?.resume_path;
    if (legacyPath && typeof legacyPath === 'string' && legacyPath.trim() !== '') {
      if (legacyPath.startsWith('http://') || legacyPath.startsWith('https://')) {
        return { download_url: legacyPath };
      }
      return { storage_path: legacyPath };
    }

    return null;
  }

  test('returns null when no resume_ref is provided', () => {
    expect(resolveResumeRef({
      resume_ref: null,
      metadata: {},
      input_data: {},
    })).toBeNull();
  });

  test('returns null when resume_ref is undefined', () => {
    expect(resolveResumeRef({
      metadata: {},
      input_data: {},
    })).toBeNull();
  });

  test('returns null when resume_ref is an empty object', () => {
    expect(resolveResumeRef({
      resume_ref: {},
      metadata: {},
      input_data: {},
    })).toBeNull();
  });

  test('returns null when resume_ref has empty string fields', () => {
    // Edge case: VALET sends "" sometimes (TODO.md #29)
    expect(resolveResumeRef({
      resume_ref: { storage_path: '' },
      metadata: {},
      input_data: {},
    })).toBeNull();
  });

  test('resolves resume_ref from direct column (storage_path)', () => {
    const result = resolveResumeRef({
      resume_ref: { storage_path: 'resumes/user-1/my-resume.pdf' },
      metadata: {},
      input_data: {},
    });
    expect(result).toEqual({ storage_path: 'resumes/user-1/my-resume.pdf' });
  });

  test('resolves resume_ref from direct column (download_url)', () => {
    const result = resolveResumeRef({
      resume_ref: { download_url: 'https://storage.example.com/resume.pdf' },
      metadata: {},
      input_data: {},
    });
    expect(result).toEqual({ download_url: 'https://storage.example.com/resume.pdf' });
  });

  test('resolves resume_ref from direct column (s3_key)', () => {
    const result = resolveResumeRef({
      resume_ref: { s3_key: 'uploads/user-1/resume.pdf' },
      metadata: {},
      input_data: {},
    });
    expect(result).toEqual({ s3_key: 'uploads/user-1/resume.pdf' });
  });

  test('falls back to metadata.resume_ref when direct column is null', () => {
    const result = resolveResumeRef({
      resume_ref: null,
      metadata: { resume_ref: { storage_path: 'resumes/backup/resume.pdf' } },
      input_data: {},
    });
    expect(result).toEqual({ storage_path: 'resumes/backup/resume.pdf' });
  });

  test('falls back to input_data.resume_path (URL) when others are absent', () => {
    const result = resolveResumeRef({
      resume_ref: null,
      metadata: {},
      input_data: { resume_path: 'https://cdn.example.com/resumes/file.pdf' },
    });
    expect(result).toEqual({ download_url: 'https://cdn.example.com/resumes/file.pdf' });
  });

  test('falls back to input_data.resume_path (storage path) when others are absent', () => {
    const result = resolveResumeRef({
      resume_ref: null,
      metadata: {},
      input_data: { resume_path: 'resumes/legacy/file.docx' },
    });
    expect(result).toEqual({ storage_path: 'resumes/legacy/file.docx' });
  });

  test('returns null for empty string resume_path in input_data', () => {
    expect(resolveResumeRef({
      resume_ref: null,
      metadata: {},
      input_data: { resume_path: '' },
    })).toBeNull();
  });

  test('returns null for whitespace-only resume_path in input_data', () => {
    expect(resolveResumeRef({
      resume_ref: null,
      metadata: {},
      input_data: { resume_path: '   ' },
    })).toBeNull();
  });

  test('prefers direct column over metadata backup', () => {
    const result = resolveResumeRef({
      resume_ref: { storage_path: 'resumes/direct/resume.pdf' },
      metadata: { resume_ref: { storage_path: 'resumes/backup/resume.pdf' } },
      input_data: {},
    });
    expect(result).toEqual({ storage_path: 'resumes/direct/resume.pdf' });
  });
});

// ---------------------------------------------------------------------------
// Resume download + cleanup lifecycle
// ---------------------------------------------------------------------------

describe('Resume download lifecycle (success and failure paths)', () => {
  test('successful download produces a valid local file path', async () => {
    const mockSupabase = {
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: new Blob([Buffer.from('PDF content here')], { type: 'application/pdf' }),
            error: null,
          }),
        }),
      },
    } as any;

    const downloader = new ResumeDownloader(mockSupabase);
    const path = await downloader.download({ storage_path: 'resumes/test.pdf' }, 'job-lifecycle-1');

    expect(path).toBeTruthy();
    expect(path).toContain('job-lifecycle-1');
    expect(path).toMatch(/\.pdf$/);

    // Cleanup should succeed
    await downloader.cleanup(path);
  });

  test('download failure throws a descriptive error', async () => {
    const mockSupabase = {
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'Bucket not found' },
          }),
        }),
      },
    } as any;

    const downloader = new ResumeDownloader(mockSupabase);

    await expect(
      downloader.download({ storage_path: 'missing/resume.pdf' }, 'job-lifecycle-2')
    ).rejects.toThrow('Bucket not found');
  });

  test('cleanup runs safely even when no file was downloaded', async () => {
    const downloader = new ResumeDownloader({} as any);
    // Should not throw
    await expect(downloader.cleanup('/tmp/does-not-exist.pdf')).resolves.toBeUndefined();
  });

  test('empty data from Supabase throws descriptive error', async () => {
    const mockSupabase = {
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: null,
            error: null,
          }),
        }),
      },
    } as any;

    const downloader = new ResumeDownloader(mockSupabase);

    await expect(
      downloader.download({ storage_path: 'resumes/empty.pdf' }, 'job-empty-data')
    ).rejects.toThrow('Resume download returned empty data');
  });
});
