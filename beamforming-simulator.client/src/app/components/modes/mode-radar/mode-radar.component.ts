import {
  Component,
  NgZone,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  AfterViewInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ProbeArrayComponent } from '../../probe-array/probe-array.component';
import { BeamformingService } from '../../../services/beamforming.service';
import {
  ArrayConfig,
  makeDefaultArrayConfig,
  PREDEFINED_SCENARIOS,
} from '../../../models/beamforming.models';
import {
  InterferenceFieldComponent,
  ElementPosition,
} from '../../interference-field/interference-field.component';

// ── How many degrees the beam must sweep before we dispatch a scan request.
// Larger = fewer requests, coarser real-time data. 10° is a good balance.
const CHUNK_DEG = 10;

// ── Blip persistence in milliseconds (independent of frame rate)
const BLIP_TTL_MS = 4000; // phased-array detection marker lifetime
const TRD_BLIP_TTL_MS = 3000; // traditional radar marker lifetime

interface DetectionData {
  snr_db: number;
  doppler_m_s: number;
  estimated_rcs: number;
  range_m: number;
  angle_deg: number;
}

interface RadarTarget {
  id: string;
  angle: number; // bearing, degrees (0 = North, clockwise)
  range: number; // normalised 0–1 relative to maxRangeKm
  rcs: number; // m²
  label: string;
  detectedAt: number; // Date.now() of last detection, -Infinity if never
  trdDetectedAt: number;
  lastDetection: DetectionData | null;
}

@Component({
  selector: 'app-mode-radar',
  standalone: true,
  imports: [CommonModule, FormsModule, ProbeArrayComponent, InterferenceFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mode-radar.component.html',
  styleUrls: ['./mode-radar.component.css'],
})
export class ModeRadarComponent implements OnInit, AfterViewInit, OnDestroy {
  // FIX 1: static:true so ViewChild resolves before first draw call.
  @ViewChild('bfCanvas', { static: true }) bfCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('trdCanvas', { static: true }) trdCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('patternCanvas', { static: true }) patternCanvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Public state ─────────────────────────────────────────────
  arrayConfig: ArrayConfig = makeDefaultArrayConfig(12);
  targets: RadarTarget[] = [];
  scanAngle: number = 0;
  scanSpeed: number = 1.2; // degrees per animation frame
  scanRange: number = 1; // multiplier on maxRangeKm
  scanDirection: number = 1;
  sweepMode: 'sector' | 'full' = 'full';
  sectorMin: number = -60;
  sectorMax: number = 60;
  detectedCount: number = 0;

  txPower: number = 70.0;
  prfHz: number = 1000.0;
  pulseWidthUs: number = 1.0;
  radarInfo: any = null;

  // ── Private state ─────────────────────────────────────────────
  private trdAngle: number = 0;
  private animId: number = 0;
  private radarReady: boolean = false;
  private backendBusy: boolean = false;
  private lastBackendAngle: number = 0; // always kept mod 360
  private angleSinceLastReq: number = 0; // accumulated degrees since last request
  private patternDirty: boolean = false;

  readonly maxRangeKm = 100;

  // Offscreen phosphor canvas
  private ppiCanvas!: HTMLCanvasElement;
  private ppiCtx!: CanvasRenderingContext2D;

  // ── Computed properties ───────────────────────────────────────

  // FIX 10: prefer backend value when available
  get physicalBeamWidthDeg(): number {
    if (this.radarInfo?.hpbw_deg) return this.radarInfo.hpbw_deg;
    const freqMHz = this.arrayConfig.elements[0]?.frequency ?? 9500;
    const lambda = 3e8 / (freqMHz * 1e6);
    const N = Math.max(this.arrayConfig.elements.filter((e) => e.enabled).length, 1);
    const d = this.arrayConfig.elementSpacing / 1000;
    const aperture = Math.max((N - 1) * d, d);
    return Math.min(90, Math.max(1, (((0.886 * lambda) / aperture) * 180) / Math.PI));
  }

  // FIX 11: read from radarInfo instead of re-deriving
  get rangeResolutionM(): number {
    return this.radarInfo?.range_resolution_m ?? 150 * this.pulseWidthUs;
  }

  get maxUnambRangeKm(): number {
    return this.radarInfo?.max_unambiguous_range_m != null
      ? this.radarInfo.max_unambiguous_range_m / 1000
      : 3e8 / (2 * this.prfHz) / 1000;
  }

  get sideLobeLevel(): number {
    return this.radarInfo?.side_lobe_level ?? -13.5;
  }

  get arrayGainDb(): number {
    return this.radarInfo?.array_gain_db ?? 0;
  }

  get wavelengthM(): number {
    return this.radarInfo?.wavelength_m ?? 0;
  }

  get hpbwDeg(): number {
    return this.radarInfo?.hpbw_deg ?? this.physicalBeamWidthDeg;
  }

  constructor(
    private beamSvc: BeamformingService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    const preset = PREDEFINED_SCENARIOS.find((s) => s.mode === 'radar');
    if (preset) this.arrayConfig = { ...preset.array };

    this.targets = [
      {
        id: 't1',
        angle: 35,
        range: 0.55,
        rcs: 5,
        label: 'TGT-A',
        detectedAt: -Infinity,
        trdDetectedAt: -Infinity,
        lastDetection: null,
      },
      {
        id: 't2',
        angle: 120,
        range: 0.7,
        rcs: 3,
        label: 'TGT-B',
        detectedAt: -Infinity,
        trdDetectedAt: -Infinity,
        lastDetection: null,
      },
      {
        id: 't3',
        angle: 220,
        range: 0.4,
        rcs: 8,
        label: 'TGT-C',
        detectedAt: -Infinity,
        trdDetectedAt: -Infinity,
        lastDetection: null,
      },
    ];

    this.beamSvc.setupRadar(this.buildRadarSetupRequest(this.arrayConfig)).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;
        this.patternDirty = true;
        this.cdr.markForCheck();
      },
      error: (e) => console.warn('Radar setup failed:', e),
    });
  }

  ngAfterViewInit(): void {
    // FIX 4: size the offscreen canvas to match the real canvas immediately
    this.ppiCanvas = document.createElement('canvas');
    this.ppiCtx = this.ppiCanvas.getContext('2d')!;

    const realCanvas = this.bfCanvasRef.nativeElement;
    const W = realCanvas.offsetWidth || 360;
    const H = realCanvas.offsetHeight || 360;
    this.ppiCanvas.width = W;
    this.ppiCanvas.height = H;

    this.startAnimation();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
  }

  trackById(_: number, tgt: RadarTarget): string {
    return tgt.id;
  }

  get interferencePositions(): ElementPosition[] {
    const W = 360,
      H = 360;
    const cx = W / 2,
      cy = H / 2;
    const n = this.arrayConfig.elements.length;
    const d = this.arrayConfig.elementSpacing * 2;
    return this.arrayConfig.elements.map((el, i) => ({
      x: cx + (i - (n - 1) / 2) * d,
      y: cy,
      config: el,
    }));
  }

  onArrayConfigChange(cfg: ArrayConfig): void {
    this.arrayConfig = cfg;
    this.onHardwareChange();
  }

  onHardwareChange(): void {
    this.beamSvc.setupRadar(this.buildRadarSetupRequest(this.arrayConfig)).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;
        this.patternDirty = true;
        if (this.ppiCtx) this.ppiCtx.clearRect(0, 0, this.ppiCanvas.width, this.ppiCanvas.height);
        this.cdr.markForCheck();
      },
      error: (e) => console.warn('Radar re-setup failed:', e),
    });
  }

  addTarget(): void {
    if (this.targets.length >= 5) return;
    const idx = this.targets.length;
    this.targets.push({
      id: `t${Date.now()}`,
      angle: Math.random() * 360,
      range: 0.3 + Math.random() * 0.6,
      rcs: 5,
      label: `TGT-${String.fromCharCode(65 + (idx % 26))}`,
      detectedAt: -Infinity,
      trdDetectedAt: -Infinity,
      lastDetection: null,
    });
    this.cdr.markForCheck();
  }

  removeTarget(id: string): void {
    this.targets = this.targets.filter((t) => t.id !== id);
    this.cdr.markForCheck();
  }

  // ── Helpers ────────────────────────────────────────────────────

  isDetected(tgt: RadarTarget): boolean {
    return Date.now() - tgt.detectedAt < BLIP_TTL_MS;
  }

  isTrdDetected(tgt: RadarTarget): boolean {
    return Date.now() - tgt.trdDetectedAt < TRD_BLIP_TTL_MS;
  }

  // FIX 8: detection count based on ms timestamp, not frame counter
  get liveDetectedCount(): number {
    return this.targets.filter((t) => this.isDetected(t)).length;
  }

  private buildRadarSetupRequest(cfg: ArrayConfig): any {
    return {
      num_elements: cfg.numElements,
      element_spacing: cfg.elementSpacing,
      frequency_mhz: cfg.elements[0]?.frequency ?? 9500.0,
      geometry: cfg.geometry,
      curvature_radius: cfg.curvatureRadius,
      steering_angle: cfg.steeringAngle,
      focus_depth: cfg.focusDepth,
      snr: cfg.snr,
      apodization: cfg.apodizationWindow,
      noise_floor_dbm: -100.0,
      clutter_floor_dbm: -200.0,
      clutter_range_exp: -20.0,
      cfar_guard_cells: 2,
      cfar_ref_cells: 8,
      cfar_pfa: 1e-4,
      pt_dbm: this.txPower,
      prf_hz: this.prfHz,
      pulse_width_us: this.pulseWidthUs,
      wave_speed: 3e8,
      elements: cfg.elements.map((el) => ({
        element_id: el.id,
        label: el.label,
        color: el.color,
        frequency: el.frequency,
        phase_shift: el.phaseShift,
        time_delay: el.timeDelay,
        intensity: el.intensity,
        enabled: el.enabled,
        apodization_weight: el.apodizationWeight,
      })),
    };
  }

  // ── Animation loop ─────────────────────────────────────────────

  private startAnimation(): void {
    this.zone.runOutsideAngular(() => {
      const loop = () => {
        this.advanceScan();
        this.checkTraditionalDetections();

        // FIX 5: angle-chunk dispatch — no timer, no backpressure flooding.
        // A request goes out only when the beam has swept ≥ CHUNK_DEG degrees
        // and no request is currently in-flight.
        if (this.radarReady && !this.backendBusy && this.angleSinceLastReq >= CHUNK_DEG) {
          this.requestBackendScan();
        }

        this.applyPhosphorFade();
        this.drawBeamformingCanvas();
        this.drawTraditionalCanvas();

        // FIX 3: only redraw pattern when data actually changed
        if (this.patternDirty) {
          this.drawPatternCanvas();
          this.patternDirty = false;
        }

        this.animId = requestAnimationFrame(loop);
      };
      loop();
    });
  }

  private advanceScan(): void {
    let delta = this.scanSpeed;

    if (this.sweepMode === 'full') {
      this.scanAngle = (this.scanAngle + delta) % 360;
    } else {
      this.scanAngle += delta * this.scanDirection;
      if (this.scanAngle >= this.sectorMax) {
        this.scanAngle = this.sectorMax;
        this.scanDirection = -1;
      }
      if (this.scanAngle <= this.sectorMin) {
        this.scanAngle = this.sectorMin;
        this.scanDirection = 1;
      }
    }

    this.trdAngle = (this.trdAngle + 0.6) % 360;

    // FIX 5: accumulate degrees swept since last backend request
    this.angleSinceLastReq += Math.abs(delta);
  }

  private checkTraditionalDetections(): void {
    const halfBeam = 10; // 20° physical dish

    this.targets.forEach((tgt) => {
      let diff = (tgt.angle - this.trdAngle + 360) % 360;
      if (diff > 180) diff = 360 - diff;

      if (diff < halfBeam && tgt.range <= this.scanRange) {
        tgt.trdDetectedAt = Date.now(); // FIX 7: timestamp instead of counter
      }
    });
  }

  private toTargetDTO(t: RadarTarget): any {
    const range_m = t.range * this.maxRangeKm * 1000;
    const angle_rad = (t.angle * Math.PI) / 180;
    return {
      target_id: t.id,
      x_m: range_m * Math.sin(angle_rad),
      y_m: range_m * Math.cos(angle_rad),
      velocity_m_s: 0,
      rcs_sqm: t.rcs,
    };
  }

  // FIX 5 & 6: angle-chunk driven dispatch, lastBackendAngle always mod 360
  private requestBackendScan(): void {
    const startAngle = this.lastBackendAngle;
    let endAngle = this.scanAngle;

    // Handle 0°/360° wrap: if end < start by more than a half-circle, end has wrapped
    let diff = endAngle - startAngle;
    if (diff < 0) diff += 360;
    if (diff < 1) return; // safety guard

    this.backendBusy = true;
    this.angleSinceLastReq = 0;

    // Lines proportional to swept angle: ~1 line per degree, capped
    const numLines = Math.max(2, Math.min(36, Math.round(diff)));

    this.beamSvc
      .scanRadar({
        start_angle: startAngle,
        end_angle: startAngle + diff, // use unwrapped endAngle
        num_lines: numLines,
        max_range_m: this.scanRange * this.maxRangeKm * 1000,
        targets: this.targets.map((t) => this.toTargetDTO(t)),
      })
      .subscribe({
        next: (res: any) => {
          this.backendBusy = false;
          // FIX 6: always store mod 360
          this.lastBackendAngle = this.scanAngle % 360;

          if (res?.sweep_data) {
            this.paintRawPhysicsToPhosphor(res.sweep_data);
          }

          if (res?.detections?.length) {
            const now = Date.now();
            this.targets.forEach((tgt) => {
              const d: any = res.detections.find((x: any) => x.target_id === tgt.id);
              if (d) {
                tgt.detectedAt = now;
                // FIX 8 & 11: store rich detection data
                tgt.lastDetection = {
                  snr_db: d.snr_db,
                  doppler_m_s: d.doppler_m_s,
                  estimated_rcs: d.estimated_rcs,
                  range_m: d.range_m,
                  angle_deg: d.angle_deg,
                };
              }
            });

            const newCount = this.liveDetectedCount;
            if (newCount !== this.detectedCount) {
              this.detectedCount = newCount;
              this.zone.run(() => this.cdr.markForCheck());
            }
          }
        },
        error: () => {
          this.backendBusy = false;
        },
      });
  }

  // ── Rendering ─────────────────────────────────────────────────

  private applyPhosphorFade(): void {
    if (!this.ppiCtx) return;
    this.ppiCtx.globalCompositeOperation = 'source-over';
    this.ppiCtx.fillStyle = 'rgba(0,0,0,0.015)';
    this.ppiCtx.fillRect(0, 0, this.ppiCanvas.width, this.ppiCanvas.height);
  }

  private paintRawPhysicsToPhosphor(sweep_data: any[]): void {
    if (!this.ppiCtx) return;
    const W = this.ppiCanvas.width;
    const H = this.ppiCanvas.height;
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;
    const halfRad = ((this.physicalBeamWidthDeg / 2) * Math.PI) / 180;

    this.ppiCtx.globalCompositeOperation = 'lighter';

    sweep_data.forEach((line: any) => {
      // Bearing convention: 0° = North (top), clockwise.
      // Canvas convention: 0° = East (right), counter-clockwise from Math.
      // So: canvas_angle = (bearing - 90) * π/180
      const sweepRad = ((line.angle_deg - 90) * Math.PI) / 180;
      const bins = line.range_bins as number[];
      const numBins = bins.length;

      for (let i = 0; i < numBins; i++) {
        const intensity = bins[i];
        if (intensity < 0.05) continue;

        const r0 = (i / numBins) * R;
        const r1 = ((i + 1) / numBins) * R;

        this.ppiCtx.beginPath();
        this.ppiCtx.arc(cx, cy, r1, sweepRad - halfRad, sweepRad + halfRad);
        this.ppiCtx.arc(cx, cy, r0, sweepRad + halfRad, sweepRad - halfRad, true);
        this.ppiCtx.closePath();

        const g = Math.floor(50 + intensity * 205);
        const b = Math.floor(intensity * 200);
        this.ppiCtx.fillStyle = `rgb(0,${g},${b})`;
        this.ppiCtx.fill();
      }
    });
  }

  private drawBeamformingCanvas(): void {
    const canvas = this.bfCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    // FIX 4: only resize offscreen canvas when dimensions actually change
    // (resizing clears the canvas — do it only when necessary)
    if (this.ppiCanvas.width !== W || this.ppiCanvas.height !== H) {
      this.ppiCanvas.width = W;
      this.ppiCanvas.height = H;
    }

    ctx.fillStyle = '#050a0f';
    ctx.fillRect(0, 0, W, H);

    // FIX 13: labelled range rings
    this.drawRadarBg(ctx, cx, cy, R, 'rgba(26,115,232,0.15)', true);

    ctx.drawImage(this.ppiCanvas, 0, 0);

    // Sweep line
    const angleRad = ((this.scanAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.strokeStyle = 'rgba(26,115,232,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // FIX 8 & 13: rich blip labels with detection data
    const now = Date.now();
    this.targets.forEach((tgt) => {
      if (now - tgt.detectedAt >= BLIP_TTL_MS) return;

      const rad = ((tgt.angle - 90) * Math.PI) / 180;
      const dist = (tgt.range / this.scanRange) * R;
      if (dist > R) return;

      const tx = cx + dist * Math.cos(rad);
      const ty = cy + dist * Math.sin(rad);
      const size = 4 + tgt.rcs * 1.5;
      const fade = 1 - (now - tgt.detectedAt) / BLIP_TTL_MS;
      const alpha = Math.max(0, Math.min(1, fade * 2)); // faster fade at end

      ctx.strokeStyle = `rgba(0,255,200,${alpha * 0.8})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tx - size / 2, ty - size / 2, size, size);

      ctx.fillStyle = `rgba(0,255,200,${alpha * 0.8})`;
      ctx.font = '9px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(tgt.label, tx + size / 2 + 4, ty + 3);

      // FIX 11: show SNR and Doppler from backend detection data
      if (tgt.lastDetection) {
        const d = tgt.lastDetection;
        const snr = d.snr_db.toFixed(1);
        const dop = d.doppler_m_s.toFixed(1);
        ctx.font = '7px IBM Plex Mono, monospace';
        ctx.fillText(`SNR:${snr}dB`, tx + size / 2 + 4, ty + 12);
        ctx.fillText(`DOP:${dop}m/s`, tx + size / 2 + 4, ty + 20);
      }
    });

    // Mode label
    ctx.fillStyle = 'rgba(26,115,232,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PHASED ARRAY', cx, H - 6);

    // FIX 12: HUD showing key radar parameters from radarInfo
    if (this.radarInfo) {
      this.drawRadarHUD(ctx, W, H);
    }
  }

  // FIX 12: render radarInfo fields that were previously silently discarded
  private drawRadarHUD(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const ri = this.radarInfo;
    const lines = [
      `Fc: ${(ri.carrier_freq_hz / 1e9).toFixed(2)} GHz`,
      `λ:  ${(ri.wavelength_m * 100).toFixed(1)} cm`,
      `G:  ${ri.array_gain_db?.toFixed(1)} dB`,
      `HPBW: ${ri.hpbw_deg?.toFixed(1)}°`,
      `ΔR: ${ri.range_resolution_m?.toFixed(0)} m`,
      `Ru: ${(ri.max_unambiguous_range_m / 1000).toFixed(0)} km`,
    ];

    ctx.font = '8px IBM Plex Mono, monospace';
    ctx.textAlign = 'left';

    lines.forEach((line, i) => {
      const x = 6;
      const y = 14 + i * 11;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - 2, y - 9, 92, 11);
      ctx.fillStyle = 'rgba(26,115,232,0.85)';
      ctx.fillText(line, x, y);
    });
  }

  private drawTraditionalCanvas(): void {
    const canvas = this.trdCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    ctx.fillStyle = '#050a0f';
    ctx.fillRect(0, 0, W, H);
    this.drawRadarBg(ctx, cx, cy, R, 'rgba(52,168,83,0.15)', true);

    const angleRad = ((this.trdAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.strokeStyle = 'rgba(52,168,83,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const now = Date.now();
    this.targets.forEach((tgt) => {
      if (now - tgt.trdDetectedAt >= TRD_BLIP_TTL_MS) return;

      const rad = ((tgt.angle - 90) * Math.PI) / 180;
      const dist = (tgt.range / this.scanRange) * R;
      if (dist > R) return;

      const tx = cx + dist * Math.cos(rad);
      const ty = cy + dist * Math.sin(rad);
      const size = 4 + tgt.rcs * 1.5;
      const fade = 1 - (now - tgt.trdDetectedAt) / TRD_BLIP_TTL_MS;
      const alpha = Math.max(0, Math.min(1, fade * 2));

      ctx.strokeStyle = `rgba(52,168,83,${alpha * 0.8})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tx - size / 2, ty - size / 2, size, size);

      ctx.fillStyle = `rgba(52,168,83,${alpha * 0.8})`;
      ctx.font = '9px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(tgt.label, tx + size / 2 + 4, ty + 3);
    });

    ctx.fillStyle = 'rgba(52,168,83,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MECHANICAL RADAR', cx, H - 6);
  }

  // FIX 2: fixed dB axis so sidelobe levels are physically meaningful.
  // FIX 3: only called when patternDirty = true (radarInfo just updated).
  private drawPatternCanvas(): void {
    const canvas = this.patternCanvasRef?.nativeElement;
    if (!canvas || !this.radarInfo) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 300);
    const H = (canvas.height = canvas.offsetHeight || 150);
    ctx.clearRect(0, 0, W, H);

    // 1. Extract and Normalize the Pattern
    let pattern: number[];

    if (this.radarInfo.beam_pattern_db) {
      // If the backend eventually provides ready-to-go dB values, use them.
      pattern = this.radarInfo.beam_pattern_db;
    } else if (this.radarInfo.beam_pattern && this.radarInfo.beam_pattern.length > 0) {
      // Find the absolute peak of the raw data
      const maxVal = Math.max(...this.radarInfo.beam_pattern);

      pattern = this.radarInfo.beam_pattern.map((val: number) => {
        // If the array is empty zeroes, or the value is 0, send to the floor
        if (maxVal <= 0 || val <= 0) return -60;

        // Normalize against the peak so the max ratio is exactly 1.0 (which is 0 dB)
        const ratio = val / maxVal;

        // Convert to dB, clamping anything smaller than 1 millionth of the peak to -60 dB
        return ratio > 1e-6 ? 10 * Math.log10(ratio) : -60;
      });
    } else {
      return; // No data to draw
    }

    const angles: number[] = this.radarInfo.angles_deg;
    if (!pattern || pattern.length === 0) return;

    // FIX 2: FIXED dB scale — 0 dB at top, DB_FLOOR at bottom.
    // This makes sidelobe levels (e.g. -13.5 dB) visually meaningful.
    const DB_FLOOR = -60;
    const DB_CEIL = 0;

    // Background grid lines at fixed dB levels
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const dbLevels = [0, -10, -20, -30, -40, -50, -60];

    dbLevels.forEach((db) => {
      const y = H - ((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '7px IBM Plex Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${db}`, W - 2, y - 2);
    });

    // Beam pattern curve
    ctx.beginPath();
    ctx.strokeStyle = '#34a853';
    ctx.lineWidth = 1.5;

    for (let i = 0; i < pattern.length; i++) {
      const x = (i / (pattern.length - 1)) * W;
      const dbVal = Math.max(DB_FLOOR, Math.min(DB_CEIL, pattern[i]));
      const y = H - ((dbVal - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // -3 dB marker line
    const y3dB = H - ((-3 - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * H;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,200,0,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y3dB);
    ctx.lineTo(W, y3dB);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,200,0,0.7)';
    ctx.font = '7px IBM Plex Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('-3 dB', 2, y3dB - 2);

    // Sidelobe marker
    const sll = this.sideLobeLevel;
    if (sll > DB_FLOOR && sll < -3) {
      const ySll = H - ((sll - DB_FLOOR) / (DB_CEIL - DB_FLOOR)) * H;
      ctx.setLineDash([2, 6]);
      ctx.strokeStyle = 'rgba(234,67,53,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ySll);
      ctx.lineTo(W, ySll);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(234,67,53,0.7)';
      ctx.font = '7px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`SLL ${sll.toFixed(1)} dB`, 2, ySll - 2);
    }

    // Angle axis labels (using angles_deg from backend)
    if (angles?.length) {
      const firstAngle = angles[0].toFixed(0);
      const lastAngle = angles[angles.length - 1].toFixed(0);
      const midAngle = angles[Math.floor(angles.length / 2)].toFixed(0);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '7px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${firstAngle}°`, 2, H - 2);
      ctx.textAlign = 'center';
      ctx.fillText(`${midAngle}°`, W / 2, H - 2);
      ctx.textAlign = 'right';
      ctx.fillText(`${lastAngle}°`, W - 2, H - 2);
    }
  }

  // FIX 13: added range labels on rings
  private drawRadarBg(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    lineColor: string,
    showLabels = false,
  ): void {
    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;

    const fracs = [0.25, 0.5, 0.75, 1.0];
    fracs.forEach((frac) => {
      ctx.beginPath();
      ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
      ctx.stroke();

      // FIX 13: label each ring with its km distance
      if (showLabels) {
        const km = (frac * this.scanRange * this.maxRangeKm).toFixed(0);
        const lx = cx + R * frac * Math.cos(-Math.PI / 4); // label at ~NE
        const ly = cy + R * frac * Math.sin(-Math.PI / 4);
        ctx.fillStyle = lineColor.replace('0.15', '0.5').replace('0.1', '0.4');
        ctx.font = '7px IBM Plex Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${km}km`, lx, ly);
      }
    });

    // Crosshair spokes
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // Cardinal compass ticks
    const cardinals = ['N', 'E', 'S', 'W'];
    cardinals.forEach((label, i) => {
      const a = ((i * 90 - 90) * Math.PI) / 180;
      const tx = cx + (R + 10) * Math.cos(a);
      const ty = cy + (R + 10) * Math.sin(a);
      ctx.fillStyle = lineColor.replace('0.15', '0.6').replace('0.1', '0.5');
      ctx.font = 'bold 8px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, tx, ty + 3);
    });

    ctx.restore();
  }
}
