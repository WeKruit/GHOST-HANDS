import { SupabaseClient } from '@supabase/supabase-js';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { getLogger } from '../monitoring/logger.js';

export interface ResumeRef {
  storage_path?: string;
  s3_key?: string;
  download_url?: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.doc'];
const DOWNLOAD_TIMEOUT_MS = 30_000;

export class ResumeDownloader {
  private supabase: SupabaseClient;
  private tempDir: string;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.tempDir = join(tmpdir(), 'ghosthands-resumes');
  }

  /**
   * Download a resume from one of: Supabase Storage, S3, or pre-signed URL.
   * Returns the local file path of the downloaded resume.
   */
  async download(resumeRef: ResumeRef, jobId: string): Promise<string> {
    // Ensure temp directory exists
    await mkdir(this.tempDir, { recursive: true });

    if (resumeRef.storage_path) {
      return this.downloadFromSupabase(resumeRef.storage_path, jobId);
    }

    if (resumeRef.download_url) {
      return this.downloadFromUrl(resumeRef.download_url, jobId);
    }

    if (resumeRef.s3_key) {
      return this.downloadFromS3(resumeRef.s3_key, jobId);
    }

    throw new Error('No valid resume source provided (storage_path, s3_key, or download_url)');
  }

  /**
   * Clean up a downloaded resume file.
   */
  async cleanup(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      // File may already be deleted
    }
  }

  private async downloadFromSupabase(storagePath: string, jobId: string): Promise<string> {
    // VALET uploads via Supabase's S3-compatible API with bucket "resumes"
    // and stores the S3 key (e.g. "resumes/userId/uuid-file.pdf") as file_key.
    // The Supabase JS client needs the full S3 key as the path within the bucket.
    const bucket = 'resumes';
    const path = storagePath;

    const { data, error } = await this.supabase.storage
      .from(bucket)
      .download(path);

    if (error) {
      const errorMsg = (error as any)?.message || JSON.stringify(error) || 'Unknown storage error';
      throw new Error(`Failed to download resume from Supabase Storage (bucket=${bucket}, path=${path}): ${errorMsg}`);
    }

    if (!data) {
      throw new Error('Resume download returned empty data');
    }

    const extension = this.getExtension(path);
    this.validateExtension(extension);

    const buffer = Buffer.from(await data.arrayBuffer());
    this.validateSize(buffer);

    const localPath = this.buildTempPath(jobId, extension);
    await writeFile(localPath, buffer);

    getLogger().info('Downloaded resume from Supabase', { storagePath, localPath });
    return localPath;
  }

  private async downloadFromUrl(url: string, jobId: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GhostHands-ResumeDownloader/1.0' },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Resume download failed with status ${response.status}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        throw new Error(`Resume file too large: ${contentLength} bytes (max ${MAX_FILE_SIZE})`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      this.validateSize(buffer);

      // Try to determine extension from URL or content-type
      const extension = this.getExtensionFromUrl(url, response.headers.get('content-type'));
      this.validateExtension(extension);

      const localPath = this.buildTempPath(jobId, extension);
      await writeFile(localPath, buffer);

      getLogger().info('Downloaded resume from URL', { localPath });
      return localPath;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  private async downloadFromS3(s3Key: string, jobId: string): Promise<string> {
    // S3 download requires generating a pre-signed URL first
    // For now, construct a pre-signed URL using environment config
    const bucket = process.env.AWS_S3_RESUME_BUCKET;
    const region = process.env.AWS_REGION || 'us-east-1';

    if (!bucket) {
      throw new Error('AWS_S3_RESUME_BUCKET not configured for S3 resume downloads');
    }

    // Use the S3 public URL pattern (works for public buckets or with IAM)
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
    return this.downloadFromUrl(url, jobId);
  }

  private getExtension(path: string): string {
    const lastDot = path.lastIndexOf('.');
    if (lastDot === -1) return '.pdf'; // default
    return path.slice(lastDot).toLowerCase();
  }

  private getExtensionFromUrl(url: string, contentType?: string | null): string {
    // Try content-type first
    if (contentType) {
      if (contentType.includes('pdf')) return '.pdf';
      if (contentType.includes('word') || contentType.includes('docx')) return '.docx';
      if (contentType.includes('msword')) return '.doc';
    }

    // Try URL path
    try {
      const pathname = new URL(url).pathname;
      const ext = this.getExtension(pathname);
      if (ALLOWED_EXTENSIONS.includes(ext)) return ext;
    } catch {
      // Invalid URL
    }

    return '.pdf'; // default assumption
  }

  private validateExtension(extension: string): void {
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      throw new Error(`Unsupported resume file type: ${extension}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
    }
  }

  private validateSize(buffer: Buffer): void {
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`Resume file too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);
    }
    if (buffer.length === 0) {
      throw new Error('Resume file is empty');
    }
  }

  private buildTempPath(jobId: string, extension: string): string {
    return join(this.tempDir, `${jobId}-${randomUUID().slice(0, 8)}${extension}`);
  }
}
