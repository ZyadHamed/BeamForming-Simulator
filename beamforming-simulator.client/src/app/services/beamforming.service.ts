// ══════════════════════════════════════════════════════════════════
//  BeamformingService  –  API bridge + mock demo data
//  All FFT / IFFT computation is delegated to the backend.
//  Mock implementations generate plausible waveforms for dev/demo.
// ══════════════════════════════════════════════════════════════════

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, delay, Subject } from 'rxjs';
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
  current_tower_id: string | null;
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

/** Shape of one sector returned by GET /5g-scenario/tower-beams/:id */
export interface SectorBeamData {
  name: string;
  boresight_deg: number;
  steering_angle_deg: number;
  global_pointing_deg: number;
  scan_angles_deg: number[];
  beam_pattern_db: number[];
  array_config: {
    num_elements: number;
    element_spacing_mm: number;
    frequency_mhz: number;
    apodization: string;
    snr_db: number;
  };
}

export interface TowerBeamsResponse {
  tower_id: string;
  sectors: SectorBeamData[];
}

export interface TowerConfigUpdateRequest {
  tower_id: string;
  apodization: string;
  snr: number;
  kaiser_beta?: number;
  num_elements?: number;
  element_spacing_mm?: number;
}


// ── Environment switch ─────────────────────────────────────────────
const USE_MOCK = false; // ← flip to false once backend is live
const API_BASE = 'http://localhost:8000'; // ← configure to match your backend
const WS_BASE = 'WS://localhost:8000';
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


private bfSocket: WebSocket | null = null;
private trdSocket: WebSocket | null = null;
private bfScanResult$ = new Subject<{
  sweep_data: any[];
  detections: any[];
  interference_image?: string;
  interference_cols?: number;
  interference_rows?: number;
  beam_pattern?: number[];
  angles_deg?: number[];
  beam_angle?: number;
  main_lobe_width?: number;
  side_lobe_level?: number | null;
}>();
private trdScanResult$ = new Subject<{ sweep_data: any[]; detections: any[] }>();

// ADD this method — call once on component init to open sockets:
openScanSockets(): void {
  this.closeScanSockets();

  this.bfSocket = new WebSocket(`${WS_BASE}/radar/scan`);
  this.bfSocket.onmessage = (ev) => {
    try { this.bfScanResult$.next(JSON.parse(ev.data)); } catch {}
  };

  this.bfSocket.onopen = () => this.bfSocket?.send(JSON.stringify({
    start_angle: 0, end_angle: 360, num_lines: 1,
    max_range_m: 150000, num_range_bins: 128,
    targets: [], radar_type: 'phased_array',
  }));

  // Traditional socket (second independent connection)
  this.trdSocket = new WebSocket(`${WS_BASE}/radar/scan`);
  this.trdSocket.onmessage = (ev) => {
    try { this.trdScanResult$.next(JSON.parse(ev.data)); } catch {}
  };
  this.trdSocket.onopen = () => this.trdSocket?.send(JSON.stringify({
    start_angle: 0, end_angle: 360, num_lines: 1,
    max_range_m: 150000, num_range_bins: 128,
    targets: [], radar_type: 'traditional',
  }));
}

// ADD this method — call on component destroy:
closeScanSockets(): void {
  this.bfSocket?.close();
  this.trdSocket?.close();
  this.bfSocket = null;
  this.trdSocket = null;
}

// these two methods — push a scan slice and receive the result stream:
sendBfScanSlice(req: object): void {
  if (this.bfSocket?.readyState === WebSocket.OPEN) {
    this.bfSocket.send(JSON.stringify({ ...req, radar_type: 'phased_array' }));
  }
}

sendTrdScanSlice(req: object): void {
  if (this.trdSocket?.readyState === WebSocket.OPEN) {
    this.trdSocket.send(JSON.stringify({ ...req, radar_type: 'traditional' }));
  }
}

sendBfReady(): void {
  if (this.bfSocket?.readyState === WebSocket.OPEN) {
    this.bfSocket.send('READY');
  }
}

sendTrdReady(): void {
  if (this.trdSocket?.readyState === WebSocket.OPEN) {
    this.trdSocket.send('READY');
  }
}

get bfScanResults$(): Observable<{
  sweep_data: any[];
  detections: any[];
  interference_image?: string;
  interference_cols?: number;
  interference_rows?: number;
  beam_pattern?: number[];
  angles_deg?: number[];
  beam_angle?: number;
  main_lobe_width?: number;
  side_lobe_level?: number | null;
}> {
  return this.bfScanResult$.asObservable();
}

get trdScanResults$(): Observable<{ sweep_data: any[]; detections: any[] }> {
  return this.trdScanResult$.asObservable();
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

  /**
   * Fetch polar beam-pattern data for all 3 sectors of a tower.
   * GET /5g-scenario/tower-beams/:towerId
   */
  getTowerBeams(towerId: string): Observable<TowerBeamsResponse> {
    return this.http.get<TowerBeamsResponse>(`${API_BASE}/5g-scenario/tower-beams/${towerId}`);
  }

  /**
   * Update apodization / SNR for a tower and get back fresh beam patterns.
   * POST /5g-scenario/update-tower-config
   */
  updateTowerConfig(req: TowerConfigUpdateRequest): Observable<TowerBeamsResponse> {
    return this.http.post<TowerBeamsResponse>(`${API_BASE}/5g-scenario/update-tower-config`, req);
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
