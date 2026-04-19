// ══════════════════════════════════════════════════════════════════
//  ModeRadarComponent  –  Phased-array radar beamforming simulator
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

interface RadarTarget {
  id: string;
  angle: number;
  range: number;
  rcs: number;
  label: string;
  detected: boolean;
  blipAge: number;
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
  @ViewChild('patternCanvas', { static: false }) patternCanvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Public state bound in template ────────────────────────────
  arrayConfig: ArrayConfig = makeDefaultArrayConfig(12);
  targets: RadarTarget[] = [];
  scanAngle: number = 0;
  scanSpeed: number = 1.2;
  scanRange: number = 1;
  scanDirection: number = 1;
  sweepMode: 'sector' | 'full' = 'full';
  sectorMin: number = -60;
  sectorMax: number = 60;
  detectedCount: number = 0;
  showRangeBins: boolean = true;

  // Hardware capabilities mapping to the backend
  txPower: number = 70.0;
  prfHz: number = 1000.0;
  pulseWidthUs: number = 1.0;
  radarInfo: any = null;

  // ── Private state ─────────────────────────────────────────────
  private trdAngle: number = 0;
  private animId: number = 0;
  private t: number = 0;
  private radarReady: boolean = false;
  private backendBusy: boolean = false;
  private lastBackendAngle: number = 0;
  private lastRequestTime: number = 0;
  readonly maxRangeKm = 100;
  private readonly trdScanSpeed = 0.6;
  private readonly trdBeamWidth = 20;
  private sweepVisuals: { angle_deg: number; range_bins: number[]; age: number }[] = [];

  get physicalBeamWidthDeg(): number {
    const freqMHz = this.arrayConfig.elements[0]?.frequency ?? 9500;
    const f_hz = freqMHz * 1e6;
    const lambda = 3e8 / f_hz;
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

    this.startAnimation();

    this.beamSvc.setupRadar(this.buildRadarSetupRequest(this.arrayConfig)).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;
        this.cdr.markForCheck();
      },
      error: (e) => console.warn('Radar setup failed:', e),
    });
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
    this.beamSvc.setupRadar(this.buildRadarSetupRequest(cfg)).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;
        this.cdr.markForCheck();
      },
      error: (e) => console.warn('Radar re-setup failed:', e),
    });
  }

  onHardwareChange(): void {
    // Re-trigger the backend setup when the user slides a hardware dial
    this.onArrayConfigChange(this.arrayConfig);
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

  // Bind the UI state into the DTO matching Python's RadarSetupRequest
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

  onRcsChange(id: string, value: number): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, rcs: +value } : t));
    this.cdr.markForCheck();
  }

  onAngleChange(id: string, value: number): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, angle: +value } : t));
    this.cdr.markForCheck();
  }

  onRangeChange(id: string, value: number): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, range: +value } : t));
    this.cdr.markForCheck();
  }

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

        if (this.t % 10 === 0) {
          this.drawPatternCanvas();
          this.zone.run(() => this.cdr.markForCheck());
        }

        this.animId = requestAnimationFrame(loop);
      };
      loop();
    });
  }

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
    this.sweepVisuals = this.sweepVisuals.filter((s) => s.age < 150);
  }

  private checkLocalPhasedArrayDetections(): void {
    const hpbw = this.physicalBeamWidthDeg;
    const halfBeam = hpbw / 2;

    this.targets = this.targets.map((tgt) => {
      const aged = { ...tgt, blipAge: tgt.blipAge + 1 };

      // Fallback local detection if backend is unavailable
      // (Backend overwrites this automatically when healthy)
      if (!this.radarReady) {
        let diff = (tgt.angle - this.scanAngle + 360) % 360;
        if (diff > 180) diff = 360 - diff;

        const rcsBonusDeg = Math.min(2, tgt.rcs * 0.1);
        if (diff < halfBeam + rcsBonusDeg && tgt.range <= this.scanRange) {
          return { ...aged, detected: true, blipAge: 0 };
        }
      }
      return { ...aged, detected: aged.blipAge < 200 };
    });
    this.detectedCount = this.targets.filter((t) => t.blipAge < 120).length;
  }

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

  // Convert UI polar coordinates to backend Cartesian
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

  private requestBackendScan(): void {
    if (!this.radarReady) return;

    let startAngle = this.lastBackendAngle;
    let endAngle = this.scanAngle;

    if (endAngle < startAngle && startAngle - endAngle > 180) endAngle += 360;
    if (startAngle < endAngle && endAngle - startAngle > 180) startAngle += 360;

    const diff = Math.abs(endAngle - startAngle);
    if (diff < 1) {
      startAngle = this.scanAngle - this.physicalBeamWidthDeg / 2;
      endAngle = this.scanAngle + this.physicalBeamWidthDeg / 2;
    }

    const numLines = Math.max(4, Math.min(45, Math.round(diff)));

    this.beamSvc
      .scanRadar({
        start_angle: startAngle,
        end_angle: endAngle,
        num_lines: numLines,
        max_range_m: this.scanRange * this.maxRangeKm * 1000,
        targets: this.targets.map((t) => this.toTargetDTO(t)),
      })
      .subscribe({
        next: (res: any) => {
          this.backendBusy = false;
          this.lastBackendAngle = endAngle;

          if (res?.sweep_data) {
            res.sweep_data.forEach((line: any) => {
              this.sweepVisuals.push({
                angle_deg: line.angle_deg,
                range_bins: line.range_bins,
                age: 0,
              });
            });
          }

          if (res?.detections) {
            this.targets = this.targets.map((tgt) => {
              const d = res.detections.find((x: any) => x.target_id === tgt.id);
              if (d) {
                return { ...tgt, detected: true, blipAge: 0 };
              }
              return tgt;
            });
            this.detectedCount = this.targets.filter((t) => t.blipAge < 120).length;
          }
        },
        error: () => {
          this.backendBusy = false;
        },
      });
  }

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

    ctx.fillStyle = 'rgba(2,10,20,0.08)';
    ctx.fillRect(0, 0, W, H);
    this.drawRadarBg(ctx, cx, cy, R, '#0a1420', '#281ae8');

    const angleRad = ((this.scanAngle - 90) * Math.PI) / 180;
    const halfRad = ((this.physicalBeamWidthDeg / 2) * Math.PI) / 180;

    // Draw solid scanning wedge
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

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(26,115,232,0.7)';
    ctx.lineWidth = 1;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad - halfRad), cy + R * Math.sin(angleRad - halfRad));
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad + halfRad), cy + R * Math.sin(angleRad + halfRad));
    ctx.stroke();

    // Plot log-compressed log bins representing true EM echoes
    if (this.showRangeBins) {
      this.sweepVisuals.forEach((sweep) => {
        const alphaFade = Math.max(0, 1 - sweep.age / 150);
        if (alphaFade <= 0.01) return;

        const bins = sweep.range_bins;
        const numBins = bins?.length;
        if (!numBins) return;

        const sweepRad = ((sweep.angle_deg - 90) * Math.PI) / 180;

        bins.forEach((intensity: number, binIdx: number) => {
          if (intensity < 0.05) return;
          const r0 = (binIdx / numBins) * R;
          const r1 = ((binIdx + 1) / numBins) * R;

          ctx.beginPath();
          ctx.moveTo(
            cx + r0 * Math.cos(sweepRad - halfRad),
            cy + r0 * Math.sin(sweepRad - halfRad),
          );
          ctx.arc(cx, cy, r1, sweepRad - halfRad, sweepRad + halfRad);
          ctx.arc(cx, cy, r0, sweepRad + halfRad, sweepRad - halfRad, true);
          ctx.closePath();

          ctx.fillStyle = `rgba(0, 255, 170, ${(intensity * alphaFade).toFixed(3)})`;
          ctx.fill();
        });
      });
    }

    this.drawTargetBlips(ctx, cx, cy, R, true);

    ctx.fillStyle = 'rgba(26,115,232,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PHASED ARRAY BEAMFORMING', cx, H - 6);
  }

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

    ctx.fillStyle = 'rgba(2,10,16,0.08)';
    ctx.fillRect(0, 0, W, H);
    this.drawRadarBg(ctx, cx, cy, R, '#060c12', '#34a853');

    const angleRad = ((this.trdAngle - 90) * Math.PI) / 180;
    const halfRad = ((this.trdBeamWidth / 2) * Math.PI) / 180;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angleRad - halfRad, angleRad + halfRad);
    ctx.closePath();

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, 'rgba(52,168,83,0.4)');
    grad.addColorStop(0.8, 'rgba(52,168,83,0.1)');
    grad.addColorStop(1, 'rgba(52,168,83,0.0)');
    ctx.fillStyle = grad;
    ctx.fill();

    this.drawTargetBlips(ctx, cx, cy, R, false);

    ctx.fillStyle = 'rgba(52,168,83,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MECHANICAL RADAR', cx, H - 6);
  }

  // Draw the new backend-derived radiation profile dynamically
  private drawPatternCanvas(): void {
    const canvas = this.patternCanvasRef?.nativeElement;
    if (!canvas || !this.radarInfo || !this.radarInfo.beam_pattern) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 300);
    const H = (canvas.height = canvas.offsetHeight || 150);

    ctx.clearRect(0, 0, W, H);

    // Grid Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const y = H - (i / 4) * H;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    const angles = this.radarInfo.angles_deg;
    const pattern = this.radarInfo.beam_pattern;

    const minDb = -60;
    const maxDb = 0;

    ctx.beginPath();
    ctx.strokeStyle = '#34a853'; // Match green styling
    ctx.lineWidth = 2;

    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const x = ((a + 90) / 180) * W;

      let db = Math.max(minDb, Math.min(maxDb, pattern[i]));
      const y = H - ((db - minDb) / (maxDb - minDb)) * H;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.fillStyle = 'rgba(52, 168, 83, 0.15)';
    ctx.fill();
  }

  private drawTargetBlips(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    isPhasedArray: boolean,
  ): void {
    this.targets.forEach((tgt) => {
      const isDetected = isPhasedArray ? tgt.detected : tgt.trdDetected;
      const age = isPhasedArray ? tgt.blipAge : tgt.trdBlipAge;

      if (!isDetected || age > 150) return;

      const alpha = Math.max(0, 1 - age / 150);
      const color = isPhasedArray ? '#1a73e8' : '#34a853';

      const rad = ((tgt.angle - 90) * Math.PI) / 180;
      const dist = (tgt.range / this.scanRange) * R;
      if (dist > R) return;

      const tx = cx + dist * Math.cos(rad);
      const ty = cy + dist * Math.sin(rad);

      const radius = 2 + tgt.rcs * 0.3;

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
        ctx.font = '8px IBM Plex Mono';
        ctx.textAlign = 'left';
        ctx.fillText(` ${tgt.label}`, tx + radius + 4, ty + 3);
      }
    });
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
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - R, cy + (i * R) / 2);
      ctx.lineTo(cx + R, cy + (i * R) / 2);
      ctx.stroke();
    });
    ctx.restore();
  }
}
