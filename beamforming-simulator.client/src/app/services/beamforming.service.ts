// ══════════════════════════════════════════════════════════════════
//  BeamformingService  –  API bridge + mock demo data
//  All FFT / IFFT computation is delegated to the backend.
//  Mock implementations generate plausible waveforms for dev/demo.
// ══════════════════════════════════════════════════════════════════

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, delay } from 'rxjs';
import {
  ProbeElementConfig,
  ArrayConfig,
  BeamformingResult,
  SimMode,
  InterferenceFieldResult,
  BeamProfileResult,
} from '../models/beamforming.models';

export interface FftRequest {
  signal: number[];
  sampleRate: number; // Hz
}

export interface FftResponse {
  re: number[];
  im: number[];
  frequencies: number[];
  magnitude: number[];
  phase: number[];
}

export interface BeamformRequest {
  mode: SimMode;
  arrayConfig: ArrayConfig;
  snr?: number;
  window?: ArrayConfig['apodizationWindow'];
  targetAngle?: number;
  targetX?: number;
  targetY?: number;
  sampleRate?: number;
}

export interface RadarElementInput {
  element_id: string;
  label: string;
  color: string;
  frequency: number;
  phase_shift: number;
  time_delay: number;
  intensity: number;
  enabled: boolean;
  apodization_weight: number;
}

export interface RadarSetupRequest {
  num_elements: number;
  element_spacing: number;
  frequency_mhz: number;
  geometry: string;
  curvature_radius: number;
  steering_angle: number;
  focus_depth: number;
  snr: number;
  apodization: string;
  noise_floor_dbm: number;
  wave_speed: number;
  elements: RadarElementInput[];
}
// ── 5G Interfaces ──────────────────────────────────────────────────
export interface Tower5GRequest {
  tower_id: string;
  x_m: number;
  y_m: number;
  num_elements: number;
  element_spacing_mm: number;
  max_coverage_radius_m: number;
}

export interface User5GRequest {
  user_id: string;
  x_m: number;
  y_m: number;
  allocated_frequency_mhz: number;
}

export interface LinkQuality {
  user_id: string;
  tower_id: string;
  sector_name: string;
  global_angle_deg: number;
  local_beam_angle_deg: number;
  snr_db: number;
  data_rate_mbps: number;
}

export interface NetworkStateResult {
  timestamp: number;
  active_connections: LinkQuality[];
  dropped_users: string[];
}

// ── Environment switch ─────────────────────────────────────────────
const USE_MOCK = false; // ← flip to false once backend is live
const API_BASE = ''; // ← configure to match your backend

@Injectable({ providedIn: 'root' })
export class BeamformingService {
  constructor(private http: HttpClient) {}

  // ── Public API methods ─────────────────────────────────────────

  /** Compute FFT of a time-domain signal (delegated to backend). */
  computeFft(req: FftRequest): Observable<FftResponse> {
    if (USE_MOCK) return of(this._mockFft(req)).pipe(delay(40));
    return this.http.post<FftResponse>(`${API_BASE}/fft`, req);
  }

  /** Compute IFFT from complex spectrum (delegated to backend). */
  computeIfft(re: number[], im: number[]): Observable<number[]> {
    if (USE_MOCK) return of(this._mockIfft(re, im)).pipe(delay(40));
    return this.http.post<number[]>(`${API_BASE}/ifft`, { re, im });
  }

  /** Full beamforming pipeline: phases → FFTs → combine → IFFT. */
  computeBeamforming(req: BeamformRequest): Observable<BeamformingResult> {
    if (USE_MOCK) return of(this._mockBeamforming(req)).pipe(delay(60));
    return this.http.post<BeamformingResult>(`${API_BASE}/beamform`, req);
  }

  // ADD after computeBeamforming():

  /**
   * BACKEND PLACEHOLDER
   * POST /api/beamforming/interference-field
   */
  computeInterferenceField(params: {
    arrayConfig: ArrayConfig;
    snr: number;
    apodizationWindow: string;
    kaiserBeta: number;
    tukeyAlpha: number;
    cols: number;
    rows: number;
    depthMm: number;
  }): Observable<InterferenceFieldResult> {
    // TODO: return this.http.post<InterferenceFieldResult>(
    //   '/api/beamforming/interference-field', params
    // );
    return of(null as any);
  }

  /**
   * BACKEND PLACEHOLDER
   * POST /api/beamforming/beam-profile
   */
  computeBeamProfile(params: {
    arrayConfig: ArrayConfig;
    snr: number;
    apodizationWindow: string;
    kaiserBeta: number;
    tukeyAlpha: number;
  }): Observable<BeamProfileResult> {
    // TODO: return this.http.post<BeamProfileResult>(
    //   '/api/beamforming/beam-profile', params
    // );
    return of(null as any);
  }

  setupRadar(req: RadarSetupRequest): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${API_BASE}/radar/setup`, req);
  }

  scanRadar(req: {
    start_angle: number;
    end_angle: number;
    num_lines: number;
    max_range_m: number;
    targets: {
      target_id: string;
      x_m: number;
      y_m: number;
      velocity_m_s: number;
      rcs_sqm: number;
    }[];
  }): Observable<{ sweep_data: { angle_deg: number; range_bins: number[] }[]; detections: any[] }> {
    return this.http.post<{
      sweep_data: { angle_deg: number; range_bins: number[] }[];
      detections: any[];
    }>(`${API_BASE}/radar/scan`, req);
  }

  /** Compute element delays for a target steering angle (backend). */
  computeSteeringDelays(
    arrayConfig: ArrayConfig,
    targetAngleDeg: number,
    speedMs: number = 1540,
  ): Observable<number[]> {
    if (USE_MOCK)
      return of(this._mockSteeringDelays(arrayConfig, targetAngleDeg, speedMs)).pipe(delay(20));
    return this.http.post<number[]>(`${API_BASE}/steering-delays`, {
      arrayConfig,
      targetAngleDeg,
      speedMs,
    });
  }

  // ── 5G API methods ─────────────────────────────────────────────

  /**
   * Initialize or replace towers on the backend.
   * Call once on load, or whenever tower count / parameters change.
   * POST /5g-scenario/towers
   */
  initTowers(towers: Tower5GRequest[]): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${API_BASE}/5g-scenario/towers`, { towers });
  }

  /**
   * Push updated user positions and receive live link calculations.
   * Call this every animation frame (or on movement).
   * POST /5g-scenario/update-users
   */
  updateUsers(users: User5GRequest[]): Observable<NetworkStateResult> {
    return this.http.post<NetworkStateResult>(`${API_BASE}/5g-scenario/update-users`, { users });
  }

  // ── Mock implementations ───────────────────────────────────────
  // These generate plausible waveforms so the UI renders correctly
  // during development without a live backend.

  private _mockFft(req: FftRequest): FftResponse {
    const N = req.signal.length;
    const re: number[] = new Array(N).fill(0);
    const im: number[] = new Array(N).fill(0);
    // Discrete FT (naive – fine for small mock arrays)
    for (let k = 0; k < N; k++) {
      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N;
        re[k] += req.signal[n] * Math.cos(angle);
        im[k] -= req.signal[n] * Math.sin(angle);
      }
      re[k] /= N;
      im[k] /= N;
    }
    const magnitude = re.map((r, i) => Math.sqrt(r * r + im[i] ** 2));
    const phase = re.map((r, i) => Math.atan2(im[i], r));
    const frequencies = Array.from({ length: N }, (_, i) => (i * req.sampleRate) / N);
    return { re, im, frequencies, magnitude, phase };
  }

  private _mockIfft(re: number[], im: number[]): number[] {
    const N = re.length;
    return Array.from({ length: N }, (_, n) => {
      let val = 0;
      for (let k = 0; k < N; k++) {
        const angle = (2 * Math.PI * k * n) / N;
        val += re[k] * Math.cos(angle) - im[k] * Math.sin(angle);
      }
      return val;
    });
  }

  private _mockBeamforming(req: BeamformRequest): BeamformingResult {
    const { arrayConfig, targetAngle = 0 } = req;
    const N = 64;
    const ang = (targetAngle * Math.PI) / 180;

    const elementSpectra = arrayConfig.elements.map((el, idx) => {
      const phaseRad = (el.phaseShift * Math.PI) / 180;
      const re = Array.from(
        { length: N },
        (_, k) => (el.intensity / 100) * Math.cos(k * phaseRad + idx * 0.3),
      );
      const im = Array.from(
        { length: N },
        (_, k) => -(el.intensity / 100) * Math.sin(k * phaseRad + idx * 0.3),
      );
      return { re, im };
    });

    const combined = elementSpectra.reduce(
      (acc, spec) => ({
        re: acc.re.map((v, i) => v + spec.re[i]),
        im: acc.im.map((v, i) => v + spec.im[i]),
      }),
      { re: new Array(N).fill(0), im: new Array(N).fill(0) },
    );

    const timeDomain = this._mockIfft(combined.re, combined.im);

    return {
      elementSpectra,
      combinedSpectrum: combined,
      timeDomain,
      beamAngle: targetAngle,
      sideLobeLevel: -13.2 + Math.random() * 2,
      mainLobeWidth: 6.4 / arrayConfig.numElements,
    };
  }

  private _mockSteeringDelays(cfg: ArrayConfig, targetAngleDeg: number, speedMs: number): number[] {
    const angleRad = (targetAngleDeg * Math.PI) / 180;
    const d = cfg.elementSpacing * 1e-3; // mm → m
    return cfg.elements.map((_, i) => {
      const offset = (i - (cfg.numElements - 1) / 2) * d;
      return ((offset * Math.sin(angleRad)) / speedMs) * 1e6; // µs
    });
  }

  // ── Utility: generate a mock sine-burst signal ─────────────────
  generateSineBurst(
    freqMhz: number,
    numCycles: number = 3,
    sampleRate: number = 1e8,
    amplitude: number = 1,
  ): number[] {
    const period = 1 / (freqMhz * 1e6);
    const nSamples = Math.round(numCycles * period * sampleRate);
    return Array.from({ length: nSamples }, (_, i) => {
      const t = i / sampleRate;
      return amplitude * Math.sin(2 * Math.PI * freqMhz * 1e6 * t);
    });
  }
}
