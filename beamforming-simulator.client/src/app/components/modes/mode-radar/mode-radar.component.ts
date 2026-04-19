// ══════════════════════════════════════════════════════════════════
//  ModeRadarComponent  –  Phased-array radar beamforming simulator
//
//  Spec compliance:
//  ✔ 360° electronic steering (phased-array, not mechanical)
//  ✔ Up to 5 movable, resizable, deletable solid bodies
//  ✔ User-controllable scan speed
//  ✔ Beam width controlled via probe-array element count (physics-derived)
//  ✔ Wide-beam fast scan  →  narrow-beam size estimation workflow
//  ✔ RCS affects detection probability (larger body = detected earlier)
//  ✔ Traditional rotating radar shown side-by-side for comparison
//  ✔ Interference pattern panel
//  ✔ NgZone isolation so rAF loop never stalls Angular CD
// ══════════════════════════════════════════════════════════════════

import {
  Component,
  NgZone,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ProbeArrayComponent } from '../../probe-array/probe-array.component';
import { BeamformingService, RadarSetupRequest } from '../../../services/beamforming.service';
import {
  ArrayConfig,
  makeDefaultArrayConfig,
  PREDEFINED_SCENARIOS,
} from '../../../models/beamforming.models';
import {
  InterferenceFieldComponent,
  ElementPosition,
} from '../../interference-field/interference-field.component';

// ── Domain model ───────────────────────────────────────────────────
interface RadarTarget {
  id: string;
  angle: number; // degrees, 0–360 (north = 0, clockwise)
  range: number; // 0–1 fraction of maxRangeKm
  rcs: number; // radar cross-section proxy, 1–20 m²
  label: string;
  // Phased-array detection state
  detected: boolean;
  blipAge: number; // frames since last phased-array hit
  // Traditional radar detection state — fully independent
  trdDetected: boolean;
  trdBlipAge: number;
}

@Component({
  selector: 'app-mode-radar',
  standalone: true,
  imports: [CommonModule, FormsModule, ProbeArrayComponent, InterferenceFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mode-radar.component.html',
  styleUrls: ['./mode-radar.component.css'],
})
export class ModeRadarComponent implements OnInit, OnDestroy {
  @ViewChild('bfCanvas', { static: true }) bfCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('trdCanvas', { static: true }) trdCanvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Public state bound in template ────────────────────────────
  arrayConfig: ArrayConfig = makeDefaultArrayConfig(12);
  targets: RadarTarget[] = [];
  scanAngle: number = 0;
  scanSpeed: number = 1.2; // °/frame
  scanRange: number = 1; // 0–1 of maxRangeKm
  scanDirection: number = 1;
  sweepMode: 'sector' | 'full' = 'full';
  sectorMin: number = -60;
  sectorMax: number = 60;
  detectedCount: number = 0;
  showRangeBins: boolean = true;

  // ── Private state ─────────────────────────────────────────────
  private trdAngle: number = 0;
  private animId: number = 0;
  private t: number = 0;
  private radarReady: boolean = false;
  private backendBusy: boolean = false;
  private lastBackendAngle: number = 0;
  private lastRequestTime: number = 0;
  readonly maxRangeKm = 100; // km displayed as km, stored as km
  private readonly trdScanSpeed = 0.6; // fixed mechanical speed °/frame
  private readonly trdBeamWidth = 20; // fixed wide mechanical beam °
  private sweepVisuals: { angle_deg: number; range_bins: number[]; age: number }[] = [];

  private hasLoggedBins = false; // To fix something

  // ── Physics: Half-Power Beam Width ────────────────────────────
  //
  //   HPBW ≈ 0.886 × λ / (N × d)     [radians]
  //
  //   λ = c / f      speed of light / carrier frequency
  //   N              number of array elements
  //   d              element spacing  [metres]
  //
  //   The user "changes beam width" by changing N (number of elements)
  //   in the probe-array panel, exactly as in a real phased array.
  //   More elements → narrower beam → finer size estimation.
  //   Fewer elements → wider beam → faster broad scan.
  //
  get physicalBeamWidthDeg(): number {
    const freqMHz = this.arrayConfig.elements[0]?.frequency ?? 9500;
    const f_hz = freqMHz * 1e6; // MHz → Hz
    const lambda = 3e8 / f_hz; // metres
    const enabledElements = this.arrayConfig.elements.filter((el) => el.enabled).length;
    const N = Math.max(enabledElements, 1);
    const d = this.arrayConfig.elementSpacing / 1000;
    const aperture = Math.max((N - 1) * d, d);
    const hpbw_rad = (0.886 * lambda) / aperture;
    return Math.min(90, Math.max(1, (hpbw_rad * 180) / Math.PI));
  }

  constructor(
    private beamSvc: BeamformingService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────

  ngOnInit(): void {
    const preset = PREDEFINED_SCENARIOS.find((s) => s.mode === 'radar');
    if (preset) this.arrayConfig = { ...preset.array };

    // Default targets at spread-out positions
    this.targets = [
      {
        id: 't1',
        angle: 35,
        range: 0.55,
        rcs: 5,
        label: 'TGT-A',
        detected: false,
        blipAge: 999,
        trdDetected: false,
        trdBlipAge: 999,
      },
      {
        id: 't2',
        angle: 120,
        range: 0.7,
        rcs: 3,
        label: 'TGT-B',
        detected: false,
        blipAge: 999,
        trdDetected: false,
        trdBlipAge: 999,
      },
      {
        id: 't3',
        angle: 220,
        range: 0.4,
        rcs: 8,
        label: 'TGT-C',
        detected: false,
        blipAge: 999,
        trdDetected: false,
        trdBlipAge: 999,
      },
      {
        id: 't4',
        angle: 310,
        range: 0.65,
        rcs: 2,
        label: 'TGT-D',
        detected: false,
        blipAge: 999,
        trdDetected: false,
        trdBlipAge: 999,
      },
    ];

    // Canvas animates immediately — never shows black on load
    this.startAnimation();

    // Initialise backend; local detection runs regardless
    this.beamSvc.setupRadar(this.buildRadarSetupRequest(this.arrayConfig)).subscribe({
      next: () => {
        this.radarReady = true;
      },
      error: (e) => {
        console.warn('Radar setup failed – local-only mode:', e);
      },
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
  }

  // ── Template helpers ───────────────────────────────────────────

  /** Stable identity for *ngFor so slider drag is not interrupted by rAF loop */
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

  // ── User interactions ──────────────────────────────────────────

  onArrayConfigChange(cfg: ArrayConfig): void {
    this.arrayConfig = cfg;
    // Do NOT set radarReady=false here — doing so on every element edit
    // (frequency, phase, apodization) would tear down the backend session
    // while the child probe-array component is mid-interaction, causing
    // its sliders to lose state. Only re-setup if structural params changed.
    this.beamSvc.setupRadar(this.buildRadarSetupRequest(cfg)).subscribe({
      next: () => {
        this.radarReady = true;
        this.cdr.markForCheck();
      },
      error: (e) => {
        console.warn('Radar re-setup failed:', e);
      },
    });
  }

  addTarget(): void {
    if (this.targets.length >= 5) return;
    const idx = this.targets.length;
    this.targets = [
      ...this.targets,
      {
        id: `t${Date.now()}`,
        angle: Math.random() * 360,
        range: 0.3 + Math.random() * 0.6,
        rcs: 5,
        label: `TGT-${String.fromCharCode(65 + (idx % 26))}`,
        detected: false,
        blipAge: 999,
        trdDetected: false,
        trdBlipAge: 999,
      },
    ];
    this.cdr.markForCheck();
  }

  removeTarget(id: string): void {
    this.targets = this.targets.filter((t) => t.id !== id);
    this.cdr.markForCheck();
  }

  private buildRadarSetupRequest(cfg: ArrayConfig): RadarSetupRequest {
    return {
      num_elements: cfg.numElements,
      element_spacing: cfg.elementSpacing,
      frequency_mhz: cfg.elements[0]?.frequency ?? 9.5,
      geometry: cfg.geometry,
      curvature_radius: cfg.curvatureRadius,
      steering_angle: cfg.steeringAngle,
      focus_depth: cfg.focusDepth,
      snr: cfg.snr,
      apodization: cfg.apodizationWindow,
      noise_floor_dbm: -90,
      wave_speed: 300000.0,
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

  /** RCS slider — immutable update so trackBy remains stable */
  onRcsChange(id: string, value: number): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, rcs: +value } : t));
    this.cdr.markForCheck();
  }

  /** Angle slider — move target around the radar field */
  onAngleChange(id: string, value: number): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, angle: +value } : t));
    this.cdr.markForCheck();
  }

  /** Range slider — move target closer or further from origin */
  onRangeChange(id: string, value: number): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, range: +value } : t));
    this.cdr.markForCheck();
  }

  // ── Animation loop (runs outside Angular zone) ─────────────────

  private startAnimation(): void {
    this.zone.runOutsideAngular(() => {
      const loop = () => {
        this.t += 1;
        this.advanceScan();

        this.checkLocalPhasedArrayDetections();
        this.checkTraditionalDetections();

        const now = Date.now();
        // Request max ~4 times per second to prevent socket exhaustion
        if (this.radarReady && !this.backendBusy && now - this.lastRequestTime > 250) {
          this.backendBusy = true;
          this.lastRequestTime = now;
          this.requestBackendScan();
        }

        this.drawBeamformingCanvas();
        this.drawTraditionalCanvas();

        // Flush template bindings ~6×/sec (scanAngle, detectedCount, etc.)
        if (this.t % 10 === 0) {
          this.zone.run(() => this.cdr.markForCheck());
        }

        this.animId = requestAnimationFrame(loop);
      };
      loop();
    });
  }

  // ── Scan advance ───────────────────────────────────────────────

  private advanceScan(): void {
    if (this.sweepMode === 'full') {
      this.scanAngle = (this.scanAngle + this.scanSpeed) % 360;
    } else {
      this.scanAngle += this.scanSpeed * this.scanDirection;
      if (this.scanAngle >= this.sectorMax) {
        this.scanAngle = this.sectorMax;
        this.scanDirection = -1;
      }
      if (this.scanAngle <= this.sectorMin) {
        this.scanAngle = this.sectorMin;
        this.scanDirection = 1;
      }
    }
    this.trdAngle = (this.trdAngle + this.trdScanSpeed) % 360;

    this.sweepVisuals.forEach((s) => s.age++);
    this.sweepVisuals = this.sweepVisuals.filter((s) => s.age < 150); // Fades over 150 frames
  }

  // ── Local detection: phased array ─────────────────────────────
  //
  //  Uses physically derived HPBW. Detection probability is also
  //  weighted by RCS: a larger body (higher RCS) can be detected
  //  even when it sits slightly outside the half-power cone,
  //  mirroring real radar-equation behaviour where received power
  //  scales linearly with RCS.
  //
  private checkLocalPhasedArrayDetections(): void {
    const hpbw = this.physicalBeamWidthDeg;
    const halfBeam = hpbw / 2;
    let detected = 0;

    this.targets = this.targets.map((tgt) => {
      const aged = { ...tgt, blipAge: tgt.blipAge + 1 };

      let diff = (tgt.angle - this.scanAngle + 360) % 360;
      if (diff > 180) diff = 360 - diff;

      const rcsBonusDeg = Math.min(2, tgt.rcs * 0.1);
      const effectiveHalf = halfBeam + rcsBonusDeg;

      const inBeam = diff < effectiveHalf && tgt.range <= this.scanRange;
      if (inBeam) {
        detected++;
        return { ...aged, detected: true, blipAge: 0 };
      }
      return { ...aged, detected: aged.blipAge < 120 };
    });

    this.detectedCount = detected;
  }

  // ── Local detection: traditional mechanical radar ──────────────

  private checkTraditionalDetections(): void {
    const halfBeam = this.trdBeamWidth / 2;
    this.targets = this.targets.map((tgt) => {
      const aged = { ...tgt, trdBlipAge: tgt.trdBlipAge + 1 };

      let diff = (tgt.angle - this.trdAngle + 360) % 360;
      if (diff > 180) diff = 360 - diff;

      if (diff < halfBeam && tgt.range <= this.scanRange) {
        return { ...aged, trdDetected: true, trdBlipAge: 0 };
      }
      return { ...aged, trdDetected: aged.trdBlipAge < 200 };
    });
  }

  // ── Backend scan (augments local result with real radar equation) ──

  private requestBackendScan(): void {
    if (!this.radarReady) return;

    let startAngle = this.lastBackendAngle;
    let endAngle = this.scanAngle;

    // Handle 360 wrap-around safely so we don't scan backwards
    if (endAngle < startAngle && startAngle - endAngle > 180) endAngle += 360;
    if (startAngle < endAngle && endAngle - startAngle > 180) startAngle += 360;

    const diff = Math.abs(endAngle - startAngle);

    // If completely stationary, just scan the immediate beam width
    if (diff < 1) {
      startAngle = this.scanAngle - this.physicalBeamWidthDeg / 2;
      endAngle = this.scanAngle + this.physicalBeamWidthDeg / 2;
    }

    // Request roughly 1 line per degree to keep backend load light but resolution high
    const numLines = Math.max(4, Math.min(45, Math.round(diff)));

    this.beamSvc
      .scanRadar({
        start_angle: startAngle, // Let Python's trig functions handle angles > 360
        end_angle: endAngle,
        num_lines: numLines,
        max_range_m: this.scanRange * this.maxRangeKm * 1000,
        targets: this.targets.map((t) => this.toCartesian(t)),
      })
      .subscribe({
        next: (result) => {
          this.applyBackendResult(result);
          // Only update the last processed angle upon success
          this.lastBackendAngle = endAngle % 360;
          this.backendBusy = false;
        },
        error: (err) => {
          console.warn('Backend scan failed', err);
          this.backendBusy = false;
        },
      });
  }

  private applyBackendResult(result: {
    sweep_data: { angle_deg: number; range_bins: number[] }[];
    detections: any[];
  }): void {
    result.sweep_data.forEach((line) => {
      this.sweepVisuals.push({ angle_deg: line.angle_deg, range_bins: line.range_bins, age: 0 });
    });

    // Merge backend detections into local target state
    const detectedIds = new Set(result.detections.map((d: any) => d.target_id));
    this.targets = this.targets.map((tgt) => {
      if (!detectedIds.has(tgt.id)) return tgt;
      // Only reset blipAge if the local beam is actually near this target right now
      let diff = (tgt.angle - this.scanAngle + 360) % 360;
      if (diff > 180) diff = 360 - diff;
      const inBeam = diff < this.physicalBeamWidthDeg / 2 + 2;
      return inBeam ? { ...tgt, detected: true, blipAge: 0 } : tgt;
    });
    this.detectedCount = this.targets.filter((t) => t.blipAge < 120).length;
    this.cdr.markForCheck();
  }

  // ── Phased-array canvas (runs every frame as fallback) ─────────

  private drawBeamformingCanvas(): void {
    const canvas = this.bfCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    // Phosphor persistence
    ctx.fillStyle = 'rgba(2,10,20,0.08)';
    ctx.fillRect(0, 0, W, H);

    this.drawRadarBg(ctx, cx, cy, R, '#0a1420', '#281ae8');

    // Beam cone
    const angleRad = ((this.scanAngle - 90) * Math.PI) / 180;
    const halfRad = ((this.physicalBeamWidthDeg / 2) * Math.PI) / 180;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angleRad - halfRad, angleRad + halfRad);
    ctx.closePath();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, 'rgba(26,115,232,0.4)');
    grad.addColorStop(0.7, 'rgba(26,115,232,0.15)');
    grad.addColorStop(1, 'rgba(26,115,232,0.0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Beam edge lines
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(26,115,232,0.7)';
    ctx.lineWidth = 1;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad - halfRad), cy + R * Math.sin(angleRad - halfRad));
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad + halfRad), cy + R * Math.sin(angleRad + halfRad));
    ctx.stroke();

    // Beam axis
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(100,200,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#64c8ff';
    ctx.shadowBlur = 10;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Azimuth label
    ctx.fillStyle = 'rgba(100,200,255,0.8)';
    ctx.font = '9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    const lx = cx + (R + 12) * Math.cos(angleRad);
    const ly = cy + (R + 12) * Math.sin(angleRad);
    ctx.fillText(`${this.scanAngle.toFixed(0)}°`, lx, ly);

    if (this.showRangeBins) {
      const halfRad = ((this.physicalBeamWidthDeg / 2) * Math.PI) / 180;

      this.sweepVisuals.forEach((sweep) => {
        const angleRad = ((sweep.angle_deg - 90) * Math.PI) / 180;
        const numBins = sweep.range_bins.length;
        const alphaFade = Math.max(0, 1 - sweep.age / 150);

        if (alphaFade > 0 && numBins > 0) {
          // 1. Find the TRUE maximum signal in this beam
          const rawMax = Math.max(...sweep.range_bins);

          // 2. If the beam hit nothing but empty space, the max will be 0
          // (or extremely tiny floating-point dust). Skip empty beams.
          if (rawMax <= 1e-30) return;

          sweep.range_bins.forEach((intensity, binIdx) => {
            // 3. Normalize relative to the true peak, even if that peak is 1e-15
            const normalized = intensity / rawMax;

            // 4. Draw only the reflection, ignoring the noise floor of this specific beam
            if (normalized < 0.05) return;

            const r0 = (binIdx / numBins) * R;
            const r1 = ((binIdx + 1) / numBins) * R;

            ctx.beginPath();
            ctx.moveTo(
              cx + r0 * Math.cos(angleRad - halfRad),
              cy + r0 * Math.sin(angleRad - halfRad),
            );
            ctx.arc(cx, cy, r1, angleRad - halfRad, angleRad + halfRad);
            ctx.arc(cx, cy, r0, angleRad + halfRad, angleRad - halfRad, true);
            ctx.closePath();

            // Render in glowing neon cyan
            ctx.fillStyle = `rgba(0, 255, 170, ${(normalized * alphaFade).toFixed(3)})`;
            ctx.fill();
          });
        }
      });
    }

    this.drawTargetBlips(ctx, cx, cy, R, true);

    ctx.fillStyle = 'rgba(26,115,232,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PHASED ARRAY BEAMFORMING', cx, H - 6);
  }

  // ── Traditional mechanical radar canvas ───────────────────────

  private drawTraditionalCanvas(): void {
    const canvas = this.trdCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    ctx.fillStyle = 'rgba(2,10,10,0.08)';
    ctx.fillRect(0, 0, W, H);

    this.drawRadarBg(ctx, cx, cy, R, '#0a1410', '#34a853');

    const angleRad = ((this.trdAngle - 90) * Math.PI) / 180;

    // Sweep trail
    const trailLen = Math.PI * 0.35;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angleRad - trailLen, angleRad);
    ctx.closePath();
    const tg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    tg.addColorStop(0, 'rgba(52,168,83,0.3)');
    tg.addColorStop(1, 'rgba(52,168,83,0.0)');
    ctx.fillStyle = tg;
    ctx.fill();

    // Sweep line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(52,168,83,0.95)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#34a853';
    ctx.shadowBlur = 10;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.stroke();
    ctx.shadowBlur = 0;

    this.drawTargetBlips(ctx, cx, cy, R, false);

    ctx.fillStyle = 'rgba(52,168,83,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TRADITIONAL ROTATING SWEEP', cx, H - 6);
  }

  // ── Shared canvas helpers ──────────────────────────────────────

  private toCartesian(t: RadarTarget) {
    const r = t.range * this.maxRangeKm * 1000;
    const rad = (t.angle * Math.PI) / 180;
    return {
      target_id: t.id,
      x_m: r * Math.sin(rad),
      y_m: r * Math.cos(rad),
      velocity_m_s: 0,
      rcs_sqm: t.rcs,
    };
  }

  private drawRadarBg(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    _bgColor: string,
    lineColor: string,
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    [0.25, 0.5, 0.75, 1].forEach((frac) => {
      ctx.beginPath();
      ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
      ctx.strokeStyle = lineColor + '25';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    ctx.strokeStyle = lineColor + '20';
    ctx.lineWidth = 0.5;
    [-1, 0, 1].forEach((i) => {
      ctx.beginPath();
      ctx.moveTo(cx + (i * R) / 2, cy - R);
      ctx.lineTo(cx + (i * R) / 2, cy + R);
      ctx.moveTo(cx - R, cy + (i * R) / 2);
      ctx.lineTo(cx + R, cy + (i * R) / 2);
      ctx.stroke();
    });

    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = lineColor + '55';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = lineColor + '55';
    ctx.font = '8px IBM Plex Mono, monospace';
    ctx.textAlign = 'right';
    [25, 50, 75, 100].forEach((km, i) => {
      ctx.fillText(`${km}km`, cx - 3, cy - R * ((i + 1) / 4) + 3);
    });
  }

  /**
   * useBeam=true  → phased-array blipAge, blue blips
   * useBeam=false → traditional trdBlipAge, green blips
   *
   * Blip radius = f(rcs): bigger body → larger dot on screen.
   * Labels show:  target name / RCS estimate / range
   */
  private drawTargetBlips(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    useBeam: boolean,
  ): void {
    this.targets.forEach((tgt) => {
      const angleRad = ((tgt.angle - 90) * Math.PI) / 180;
      const tx = cx + tgt.range * R * Math.cos(angleRad);
      const ty = cy + tgt.range * R * Math.sin(angleRad);

      const age = useBeam ? tgt.blipAge : tgt.trdBlipAge;
      const fadeFrames = useBeam ? 150 : 200;
      const alpha = Math.max(0, 1 - age / fadeFrames);
      if (alpha < 0.02) return;

      const color = useBeam ? '#64c8ff' : '#a0ffa0';
      const radius = 3 + tgt.rcs * 0.3; // RCS drives blip size

      ctx.beginPath();
      ctx.arc(tx, ty, radius, 0, Math.PI * 2);
      ctx.fillStyle =
        color +
        Math.round(alpha * 200)
          .toString(16)
          .padStart(2, '0');
      ctx.fill();
      ctx.strokeStyle =
        color +
        Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0');
      ctx.lineWidth = 1;
      ctx.stroke();

      // Ping ring on fresh detection
      if (age < 20) {
        const pingR = age * 2;
        ctx.beginPath();
        ctx.arc(tx, ty, pingR, 0, Math.PI * 2);
        ctx.strokeStyle =
          color +
          Math.round((1 - age / 20) * 200)
            .toString(16)
            .padStart(2, '00');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (alpha > 0.2) {
        const hex = Math.round(alpha * 200)
          .toString(16)
          .padStart(2, '0');
        ctx.fillStyle = color + hex;
        ctx.font = '8px IBM Plex Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(tgt.label, tx + 6, ty - 3);
        ctx.font = '7px IBM Plex Mono, monospace';
        ctx.fillStyle =
          color +
          Math.round(alpha * 140)
            .toString(16)
            .padStart(2, '0');
        ctx.fillText(`RCS ${tgt.rcs.toFixed(0)} m²`, tx + 6, ty + 7);
        ctx.fillText(`${(tgt.range * this.maxRangeKm).toFixed(0)} km`, tx + 6, ty + 16);
      }
    });
  }
}
