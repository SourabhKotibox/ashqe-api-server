/**
 * Optional AWS Elemental MediaConvert HLS transcoder.
 * Enabled when AWS_MEDIACONVERT_ROLE_ARN is set (and S3 is configured).
 *
 * Env:
 *   AWS_MEDIACONVERT_ROLE_ARN   — IAM role MediaConvert assumes (required to enable)
 *   AWS_MEDIACONVERT_ENDPOINT   — account endpoint (optional; auto-discovered)
 *   AWS_MEDIACONVERT_QUEUE      — queue ARN (optional; Default)
 *   VIDEO_TRANSCODER            — auto | aws | local (default auto)
 */
import {
  MediaConvertClient,
  CreateJobCommand,
  GetJobCommand,
  DescribeEndpointsCommand,
  type CreateJobCommandInput,
} from '@aws-sdk/client-mediaconvert';
import { getS3Settings } from './s3';
import { logger } from './logger';

let cachedEndpoint: string | null = process.env.AWS_MEDIACONVERT_ENDPOINT || null;

export function isMediaConvertEnabled(): boolean {
  const mode = (process.env.VIDEO_TRANSCODER || 'auto').toLowerCase();
  if (mode === 'local') return false;
  if (mode === 'aws') return !!process.env.AWS_MEDIACONVERT_ROLE_ARN;
  return !!process.env.AWS_MEDIACONVERT_ROLE_ARN;
}

async function getClient(): Promise<MediaConvertClient> {
  const settings = await getS3Settings();
  const credentials = {
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
  };

  if (!cachedEndpoint) {
    const bootstrap = new MediaConvertClient({
      region: settings.region,
      credentials,
    });
    const desc = await bootstrap.send(new DescribeEndpointsCommand({ MaxResults: 1 }));
    cachedEndpoint = desc.Endpoints?.[0]?.Url || null;
    if (!cachedEndpoint) {
      throw new Error('Could not discover MediaConvert endpoint for this AWS account');
    }
    logger.info({ endpoint: cachedEndpoint }, 'Discovered MediaConvert endpoint');
  }

  return new MediaConvertClient({
    region: settings.region,
    credentials,
    endpoint: cachedEndpoint,
  });
}

type Quality = { name: string; height: number; maxBitrate: number; qvbrQuality: number };

/** ABR ladder — QVBR keeps visual quality while shrinking file size */
const LADDER: Quality[] = [
  { name: '360p', height: 360, maxBitrate: 1_000_000, qvbrQuality: 7 },
  { name: '480p', height: 480, maxBitrate: 1_800_000, qvbrQuality: 7 },
  { name: '720p', height: 720, maxBitrate: 3_500_000, qvbrQuality: 8 },
  { name: '1080p', height: 1080, maxBitrate: 6_500_000, qvbrQuality: 8 },
];

function filterLadder(sourceHeight: number): Quality[] {
  const filtered = LADDER.filter((q) => q.height <= sourceHeight);
  return filtered.length ? filtered : [LADDER[0]];
}

export type MediaConvertJobResult = {
  jobId: string;
  masterUrl: string;
  qualities: Array<{
    quality: string;
    url: string;
    filePath: string;
    bitrate: number;
    resolution: string;
  }>;
};

export async function startMediaConvertHlsJob(opts: {
  mediaFileId: string;
  s3Key: string;
  sourceHeight?: number;
}): Promise<{ jobId: string; outputPrefix: string }> {
  const settings = await getS3Settings();
  const roleArn = process.env.AWS_MEDIACONVERT_ROLE_ARN!;
  const queue = process.env.AWS_MEDIACONVERT_QUEUE;
  const client = await getClient();

  const inputS3 = `s3://${settings.bucket}/${opts.s3Key.replace(/^\/+/, '')}`;
  const outputPrefix = `hls/${opts.mediaFileId}`;
  const qualities = filterLadder(opts.sourceHeight || 1080);

  const outputs = qualities.map((q) => ({
    NameModifier: `_${q.name}`,
    ContainerSettings: { Container: 'M3U8' as const },
    VideoDescription: {
      Height: q.height,
      ScalingBehavior: 'DEFAULT' as const,
      CodecSettings: {
        Codec: 'H_264' as const,
        H264Settings: {
          RateControlMode: 'QVBR' as const,
          QvbrSettings: { QvbrQualityLevel: q.qvbrQuality },
          MaxBitrate: q.maxBitrate,
          SceneChangeDetect: 'TRANSITION_DETECTION' as const,
          QualityTuningLevel: 'SINGLE_PASS_HQ' as const,
          CodecProfile: 'MAIN' as const,
          CodecLevel: 'AUTO' as const,
          InterlaceMode: 'PROGRESSIVE' as const,
          GopSize: 2,
          GopSizeUnits: 'SECONDS' as const,
        },
      },
    },
    AudioDescriptions: [
      {
        AudioSourceName: 'Audio Selector 1',
        CodecSettings: {
          Codec: 'AAC' as const,
          AacSettings: {
            Bitrate: 128000,
            CodingMode: 'CODING_MODE_2_0' as const,
            SampleRate: 48000,
          },
        },
      },
    ],
    OutputSettings: {
      HlsSettings: {
        SegmentModifier: `_${q.name}`,
      },
    },
  }));

  const params: CreateJobCommandInput = {
    Role: roleArn,
    ...(queue ? { Queue: queue } : {}),
    UserMetadata: {
      mediaFileId: opts.mediaFileId,
      app: 'tataiya',
    },
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [
        {
          FileInput: inputS3,
          AudioSelectors: {
            'Audio Selector 1': { DefaultSelection: 'DEFAULT' },
          },
          VideoSelector: {},
        },
      ],
      OutputGroups: [
        {
          Name: 'HLS',
          OutputGroupSettings: {
            Type: 'HLS_GROUP_SETTINGS',
            HlsGroupSettings: {
              // No trailing slash → last path segment becomes master playlist name (master.m3u8)
              Destination: `s3://${settings.bucket}/${outputPrefix}/master`,
              SegmentLength: 6,
              MinSegmentLength: 0,
              DirectoryStructure: 'SINGLE_DIRECTORY',
              ManifestCompression: 'NONE',
              OutputSelection: 'MANIFESTS_AND_SEGMENTS',
              StreamInfResolution: 'INCLUDE',
              ClientCache: 'ENABLED',
              ManifestDurationFormat: 'INTEGER',
              CodecSpecification: 'RFC_4281',
            },
          },
          Outputs: outputs,
        },
      ],
    },
  };

  const result = await client.send(new CreateJobCommand(params));
  const jobId = result.Job?.Id;
  if (!jobId) throw new Error('MediaConvert CreateJob returned no Job.Id');

  logger.info({ jobId, mediaFileId: opts.mediaFileId, outputPrefix }, 'MediaConvert HLS job started');
  return { jobId, outputPrefix };
}

export async function waitForMediaConvertJob(
  jobId: string,
  opts?: { timeoutMs?: number; pollMs?: number }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 90 * 60 * 1000;
  const pollMs = opts?.pollMs ?? 15_000;
  const client = await getClient();
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const res = await client.send(new GetJobCommand({ Id: jobId }));
    const status = res.Job?.Status;
    if (status === 'COMPLETE') return;
    if (status === 'ERROR' || status === 'CANCELED') {
      const msg = res.Job?.ErrorMessage || `MediaConvert job ${status}`;
      throw new Error(msg);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`MediaConvert job ${jobId} timed out`);
}

export async function buildMediaConvertResult(
  mediaFileId: string,
  outputPrefix: string,
  sourceHeight = 1080
): Promise<MediaConvertJobResult> {
  const settings = await getS3Settings();
  const base =
    settings.cdnUrl ||
    `https://${settings.bucket}.s3.${settings.region}.amazonaws.com`;
  const masterUrl = `${base}/${outputPrefix}/index.m3u8`;
  const qualities = filterLadder(sourceHeight).map((q) => {
    // MediaConvert naming with NameModifier — playlist files vary; use common pattern
    const url = `${base}/${outputPrefix}/${pathSafeName(outputPrefix, q.name)}`;
    return {
      quality: q.name,
      url: masterUrl, // individual variant URLs resolved from master; keep master for each as fallback
      filePath: masterUrl,
      bitrate: Math.round(q.maxBitrate / 1000),
      resolution: `${Math.round((q.height * 16) / 9)}x${q.height}`,
    };
  });

  // Prefer pointing all quality rows at the master; player picks ABR
  return {
    jobId: '',
    masterUrl,
    qualities: qualities.map((q) => ({
      ...q,
      url: masterUrl,
      filePath: masterUrl,
    })),
  };
}

function pathSafeName(_prefix: string, quality: string): string {
  return `index_${quality}.m3u8`;
}
