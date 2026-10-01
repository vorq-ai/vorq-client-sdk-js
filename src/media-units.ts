/**
 * The media billing table — GENERATED, do not edit.
 *
 * Source: test/vectors/media-units-v1.json, distributed from the meta-repo by
 * `make media`. Regenerate with `node scripts/gen-media-units.mjs`;
 * `make media-check` fails if this file is not what that produces.
 *
 * Keys are camelCased from the master's snake_case where they reach TypeScript
 * callers (`autoOrder`); the aspect-ratio and resolution keys are the wire
 * spellings a caller actually writes and are left exactly as they are.
 */

export const MEDIA_UNITS = {
  "format": "vorq-media-units-v1",
  "defaults": {
    "dim": 1024,
    "duration_secs": 5,
    "units_out": 4096,
    "auto_duration_secs": 15
  },
  "caps": {
    "reference_pixels": 8294400,
    "reference_assets": 12,
    "reference_duration_s": 60,
    "reference_audio_bytes": 15728640
  },
  "resolutions": [
    "480p",
    "720p",
    "1080p",
    "4k"
  ],
  "autoOrder": [
    "21:9",
    "16:9",
    "4:3",
    "1:1",
    "3:4",
    "9:16"
  ],
  "autoFallback": "16:9",
  "adaptiveAspect": "adaptive",
  "autoDuration": "auto",
  "referenceKeys": [
    "image",
    "end_image",
    "video"
  ],
  "referenceListKeys": {
    "reference_images": 9,
    "reference_videos": 3,
    "reference_audios": 3
  },
  "clipKeys": [
    "video",
    "reference_videos"
  ],
  "audioKeys": [
    "reference_audios"
  ],
  "outputCeilingKeys": [
    "max_output_tokens",
    "max_tokens",
    "max_completion_tokens"
  ],
  "frames": {
    "21:9": {
      "480p": [
        976,
        416
      ],
      "720p": [
        1472,
        632
      ],
      "1080p": [
        2200,
        944
      ],
      "4k": [
        4400,
        1888
      ]
    },
    "16:9": {
      "480p": [
        854,
        480
      ],
      "720p": [
        1280,
        720
      ],
      "1080p": [
        1920,
        1080
      ],
      "4k": [
        3840,
        2160
      ]
    },
    "4:3": {
      "480p": [
        736,
        552
      ],
      "720p": [
        1112,
        832
      ],
      "1080p": [
        1664,
        1248
      ],
      "4k": [
        3328,
        2496
      ]
    },
    "1:1": {
      "480p": [
        640,
        640
      ],
      "720p": [
        960,
        960
      ],
      "1080p": [
        1440,
        1440
      ],
      "4k": [
        2880,
        2880
      ]
    },
    "3:4": {
      "480p": [
        552,
        736
      ],
      "720p": [
        832,
        1112
      ],
      "1080p": [
        1248,
        1664
      ],
      "4k": [
        2496,
        3328
      ]
    },
    "9:16": {
      "480p": [
        480,
        854
      ],
      "720p": [
        720,
        1280
      ],
      "1080p": [
        1080,
        1920
      ],
      "4k": [
        2160,
        3840
      ]
    }
  }
} as const;
