// ══════════════════════════════════════════════════════════════════
//  Beamforming Simulator – Shared Data Models
// ══════════════════════════════════════════════════════════════════

export type ArrayGeometry = 'linear' | 'curved';
export type SimMode       = 'generic-beam-forming' | 'ultrasound' | '5g' | 'radar';

  export interface ProbeElementConfig {
    id                 : string;
    label              : string;
    color              : string;
    frequency          : number; // MHz      [0.1 – 2000]
    phaseShift         : number; // degrees  [0 – 360]
    timeDelay          : number; // µs       [0 – 50]
    intensity          : number; // %        [0 – 100]
    enabled            : boolean;
    apodizationWeight  : number;
  }

  // AFTER:
  export interface ArrayConfig {
    elements           : ProbeElementConfig[];
    steeringAngle      : number;
    focusDepth         : number;
    elementSpacing     : number;
    geometry           : ArrayGeometry;
    curvatureRadius    : number;
    numElements        : number;
    snr                : number;
    apodizationWindow  : 'none' | 'hanning' | 'hamming' | 'blackman' | 'kaiser' | 'tukey';
    kaiserBeta         : number;
    tukeyAlpha         : number;
  }


  export interface BeamformingResult {
    /** Raw FFT data from the backend (complex [re,im] pairs per element) */
    elementSpectra : { re: number[]; im: number[] }[];
    /** Combined beam spectrum */
    combinedSpectrum: { re: number[]; im: number[] };
    /** Time-domain result after IFFT */
    timeDomain     : number[];
    /** Beam direction metadata */
    beamAngle      : number;
    sideLobeLevel  : number;
    mainLobeWidth  : number;
  }

  export interface InterferenceFieldResult {
    fieldData  : number[];   // flat row-major Float32 buffer, normalised 0–1
    cols       : number;
    rows       : number;
  }

  export interface BeamProfileResult {
    polarPattern  : number[];   // 181 values –90..+90
    timeDomain    : number[];   // IFFT samples
    beamAngle     : number;
    mainLobeWidth : number;
    sideLobeLevel : number;
  }


export interface ScenarioPreset {
  name    : string;
  mode    : SimMode;
  array   : ArrayConfig;
  description: string;
}

// ─── Default factory helpers ───────────────────────────────────────

const ELEMENT_COLORS = [
  '#1a73e8','#34a853','#e8a82b','#ea4335',
  '#9c27b0','#00bcd4','#ff5722','#607d8b',
  '#795548','#4caf50','#2196f3','#ff9800',
];

export function makeDefaultElement(index: number): ProbeElementConfig {
  return {
    id                : `el-${index}`,
    label             : `E${index + 1}`,
    color             : ELEMENT_COLORS[index % ELEMENT_COLORS.length],
    frequency         : 5,
    phaseShift        : 0,
    timeDelay         : 0,
    intensity         : 80,
    enabled           : true,
    apodizationWeight : 1,
  };
}

export function makeDefaultArrayConfig(numElements: number = 4): ArrayConfig {
  return {
    elements           : Array.from({ length: numElements }, (_, i) => makeDefaultElement(i)),
    steeringAngle      : 0,
    focusDepth         : 0,
    elementSpacing     : 5,
    geometry           : 'linear',
    curvatureRadius    : 60,
    numElements,
    snr                : 100,
    apodizationWindow  : 'hanning',
    kaiserBeta         : 6,
    tukeyAlpha         : 0.5,
  };
}

// ─── Predefined Scenarios ──────────────────────────────────────────

export const PREDEFINED_SCENARIOS: ScenarioPreset[] = [
  {
    name : 'Liver Ultrasound Scan',
    mode : 'ultrasound',
    description: '8-element linear array optimised for abdominal imaging at 3.5 MHz.',
    array: {
      ...makeDefaultArrayConfig(8),
      geometry : 'linear',
      elementSpacing: 8,
      steeringAngle : 0,
      focusDepth    : 70,
      elements: Array.from({ length: 8 }, (_, i) => ({
        ...makeDefaultElement(i),
        frequency  : 3.5,
        phaseShift : (i - 3.5) * 12,
        timeDelay  : Math.abs(i - 3.5) * 0.8,
        intensity  : 85,
      })),
    },
  },
  {
    name : 'Urban 5G mmWave Deployment',
    mode : '5g',
    description: '16-element array at 28 GHz tracking 3 simultaneous mobile users.',
    array: {
      ...makeDefaultArrayConfig(16),
      geometry : 'linear',
      elementSpacing: 5,
      steeringAngle : 30,
      focusDepth    : 0,
      elements: Array.from({ length: 16 }, (_, i) => ({
        ...makeDefaultElement(i),
        frequency : 28,
        phaseShift: i * 22.5,
        timeDelay : 0,
        intensity : 90,
      })),
    },
  },
  {
    name : 'Phased Radar 360° Scan',
    mode : 'radar',
    description: '12-element curved array performing full sector scan via beamforming.',
    array: {
      ...makeDefaultArrayConfig(12),
      geometry       : 'curved',
      curvatureRadius: 60,
      elementSpacing : 15,
      steeringAngle  : 0,
      focusDepth     : 0,
      elements: Array.from({ length: 12 }, (_, i) => ({
        ...makeDefaultElement(i),
        frequency : 9.5,
        phaseShift: i * 30,
        timeDelay : i * 1.2,
        intensity : 100,
      })),
    },
  },
];
