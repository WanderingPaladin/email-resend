import { z } from 'zod';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  DEFAULT_FIRST_NAME_FALLBACK,
  DEFAULT_SENDS_PER_SECOND,
  DEFAULT_WORKSHEET_NAME,
  EMAIL_PROVIDERS,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  MAX_SENDS_PER_SECOND,
  MIN_BATCH_SIZE,
  MIN_CONCURRENCY,
  MIN_SENDS_PER_SECOND,
} from './constants';

/**
 * Zod schemas used to validate every IPC payload in the main process.
 * The renderer is treated as untrusted: all limits are re-checked here.
 */

export const emailSchema = z.email();

export const bodyFormatSchema = z.enum(['text', 'html']);

export const emailProviderSchema = z.enum(EMAIL_PROVIDERS);

const trimmed = (max: number) => z.string().trim().max(max);

/** Non-secret settings persisted with electron-store. */
export const settingsSchema = z.object({
  spreadsheetId: trimmed(200).default(''),
  worksheetName: trimmed(100).default(DEFAULT_WORKSHEET_NAME),
  serviceAccountEmail: trimmed(320).default(''),
  emailProvider: emailProviderSchema.default('resend'),
  fromName: trimmed(200).default(''),
  fromEmail: trimmed(320).default(''),
  lastSubject: z.string().max(998).default(''),
  lastBody: z.string().max(100_000).default(''),
  bodyFormat: bodyFormatSchema.default('text'),
  batchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE).default(DEFAULT_BATCH_SIZE),
  concurrency: z.number().int().min(MIN_CONCURRENCY).max(MAX_CONCURRENCY).default(DEFAULT_CONCURRENCY),
  sendsPerSecond: z
    .number()
    .int()
    .min(MIN_SENDS_PER_SECOND)
    .max(MAX_SENDS_PER_SECOND)
    .default(DEFAULT_SENDS_PER_SECOND),
  firstNameFallback: trimmed(100).default(DEFAULT_FIRST_NAME_FALLBACK),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * Secrets are write-only from the renderer:
 * - string  → replace the stored secret
 * - null    → delete the stored secret
 * - omitted → keep the stored secret
 */
const secretInput = z.string().trim().min(1).max(20_000).nullable().optional();

export const saveConfigInputSchema = z.object({
  settings: settingsSchema.partial().optional(),
  resendApiKey: secretInput,
  elasticEmailApiKey: secretInput,
  mailjetApiKey: secretInput,
  mailjetSecretKey: secretInput,
  googlePrivateKey: secretInput,
});

export type SaveConfigInput = z.infer<typeof saveConfigInputSchema>;

/** Minimal shape of a Google service account JSON key file. */
export const serviceAccountFileSchema = z.object({
  client_email: z.email(),
  private_key: z.string().includes('PRIVATE KEY'),
});

/** Email content shared by test sends, dry runs and campaigns. */
export const emailContentSchema = z.object({
  fromName: z.string().trim().min(1, 'From Name is required').max(200),
  fromEmail: z.email('From Email must be a valid email address'),
  subject: z.string().trim().min(1, 'Subject is required').max(998),
  body: z.string().min(1, 'Email body is required').max(100_000),
  bodyFormat: bodyFormatSchema,
});

export type EmailContent = z.infer<typeof emailContentSchema>;

export const sendTestInputSchema = emailContentSchema.extend({
  to: z.email('Test recipient must be a valid email address'),
});

export type SendTestInput = z.infer<typeof sendTestInputSchema>;

export const previewInputSchema = z.object({
  batchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE),
});

export const campaignStartInputSchema = emailContentSchema.extend({
  batchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE),
  concurrency: z.number().int().min(MIN_CONCURRENCY).max(MAX_CONCURRENCY),
  dryRun: z.boolean(),
});

export type CampaignStartInput = z.infer<typeof campaignStartInputSchema>;

export const recoveryActionSchema = z.enum(['mark_new', 'mark_failed', 'mark_sent']);

export const recoveryApplyInputSchema = z.object({
  action: recoveryActionSchema,
  rows: z
    .array(
      z.object({
        sheetRow: z.number().int().min(2),
        email: z.string().max(320),
      }),
    )
    .min(1)
    .max(1000),
});

export type RecoveryApplyInput = z.infer<typeof recoveryApplyInputSchema>;

export const dismissReviewInputSchema = z.object({ id: z.string().min(1).max(200) });

export const copyTextInputSchema = z.object({ text: z.string().max(2_000_000) });

export const campaignIdInputSchema = z.object({ campaignId: z.uuid() });
