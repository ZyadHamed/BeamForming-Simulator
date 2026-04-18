// ══════════════════════════════════════════════════════════════════
//  ModeRadarComponent
//  Phased-array radar beamforming simulator
// ══════════════════════════════════════════════════════════════════

import {
  Component,
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
  angle: number; // degrees, 0–360
  range: number; // 0–1 fraction of maxRangeM
  rcs: number; // body size / cross-section (1–20)
  label: string;
  // Phased-array detection state
  detected: boolean;
  blipAge: number;
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

  // ── Public state (bound in template) ──────────────────────────
  arrayConfig: ArrayConfig = makeDefaultArrayConfig(12);
  targets: RadarTarget[] = [];
  scanAngle: number = 0;
  scanSpeed: number = 1.2;
  scanRange: number = 1; // 0–1 fraction of maxRangeM
  scanDirection: number = 1;
  sweepMode: 'sector' | 'full' = 'full';
  sectorMin: number = -60;
  sectorMax: number = 60;
  beamWidth: number = 30; // degrees — controls sweep width
  detectedCount: number = 0;

  // ── Private state ──────────────────────────────────────────────
  private trdAngle: number = 0;
  private animId: number = 0;
  private t: number = 0;
  private radarReady: boolean = false;
  private readonly maxRangeM = 100;
  private readonly trdScanSpeed = 0.6; // fixed, independent of scanSpeed
  private readonly trdBeamWidth = 20; // fixed wide beam, no steering

  constructor(
    private beamSvc: BeamformingService,
    private cdr: ChangeDetectorRef,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────

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

    // Canvas must animate immediately — never black
    this.startAnimation();

    // Setup radar async; scans are silently skipped until ready
    this.beamSvc
      .setupRadar({
        num_elements: this.arrayConfig.numElements,
        element_spacing: this.arrayConfig.elementSpacing,
        frequency_mhz: this.arrayConfig.elements[0]?.frequency ?? 9.5,
        geometry: this.arrayConfig.geometry,
        curvature_radius: this.arrayConfig.curvatureRadius,
        snr: this.arrayConfig.snr,
        apodization: this.arrayConfig.apodizationWindow,
        noise_floor_dbm: -90,
      })
      .subscribe({
        next: () => {
          this.radarReady = true;
        },
        error: (e) => {
          console.warn('Radar setup failed, running in local-only mode:', e);
        },
      });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
  }

  // ── Template helpers ───────────────────────────────────────────

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
    this.cdr.markForCheck();
  }

  addTarget(): void {
    if (this.targets.length >= 5) return;
    const angle = Math.random() * 360;
    const range = 0.3 + Math.random() * 0.6;
    const idx = this.targets.length;
    this.targets = [
      ...this.targets,
      {
        id: `t${Date.now()}`,
        angle,
        range,
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

  toggleSweepMode(): void {
    this.sweepMode = this.sweepMode === 'full' ? 'sector' : 'full';
  }

  // ── Animation loop ─────────────────────────────────────────────

  private startAnimation(): void {
    const loop = () => {
      this.t += 1;
      this.advanceScan();

      // Age phased-array blips every frame
      this.targets = this.targets.map((t) => ({ ...t, blipAge: t.blipAge + 1 }));

      // Traditional radar: real physical detection, independent state
      this.checkTraditionalDetections();

      // Backend scan every 6 frames
      if (this.t % 6 === 0) this.requestBackendScan();

      this.drawBeamformingFallback();
      this.drawTraditional();
      this.animId = requestAnimationFrame(loop);
    };
    loop();
  }

  private advanceScan(): void {
    // Phased array — user-controlled speed
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

    // Traditional — fixed independent speed, always full 360
    this.trdAngle = (this.trdAngle + this.trdScanSpeed) % 360;
  }

  // ── Traditional radar: real physical sweep detection ───────────

  private checkTraditionalDetections(): void {
    const halfBeam = this.trdBeamWidth / 2;
    this.targets = this.targets.map((tgt) => {
      let t = { ...tgt, trdBlipAge: tgt.trdBlipAge + 1 };
      let diff = (tgt.angle - this.trdAngle + 360) % 360;
      if (diff > 180) diff = 360 - diff;
      if (diff < halfBeam && tgt.range <= this.scanRange) {
        t = { ...t, trdDetected: true, trdBlipAge: 0 };
      } else if (t.trdBlipAge > 200) {
        t = { ...t, trdDetected: false };
      }
      return t;
    });
  }

  // ── Phased array: backend scan ─────────────────────────────────

  private requestBackendScan(): void {
    if (!this.radarReady) return;
    const sweepHalf = this.beamWidth / 2;
    // Narrower beam → more lines for finer angular resolution
    const numLines = Math.max(8, Math.round((60 / this.beamWidth) * 16));
    this.beamSvc
      .scanRadar({
        start_angle: this.scanAngle - sweepHalf,
        end_angle: this.scanAngle + sweepHalf,
        num_lines: numLines,
        max_range_m: this.scanRange * this.maxRangeM,
        targets: this.targets.map((t) => this.toCartesian(t)),
      })
      .subscribe((result) => this.applyBackendResult(result));
  }

  private applyBackendResult(result: {
    sweep_data: { angle_deg: number; range_bins: number[] }[];
    detections: any[];
  }): void {
    const canvas = this.bfCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width || 360;
    const H = canvas.height || 360;
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    // Render each sweep line as polar arc slices with SNR-mapped intensity
    result.sweep_data.forEach((line) => {
      const angleRad = ((line.angle_deg - 90) * Math.PI) / 180;
      const numBins = line.range_bins.length;
      const halfRad = ((this.beamWidth / 2) * Math.PI) / 180;

      line.range_bins.forEach((intensity, binIdx) => {
        if (intensity < 0.01) return;
        const r0 = (binIdx / numBins) * R;
        const r1 = ((binIdx + 1) / numBins) * R;

        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(angleRad - halfRad), cy + r0 * Math.sin(angleRad - halfRad));
        ctx.arc(cx, cy, r1, angleRad - halfRad, angleRad + halfRad);
        ctx.arc(cx, cy, r0, angleRad + halfRad, angleRad - halfRad, true);
        ctx.closePath();
        ctx.fillStyle = `rgba(26,115,232,${(intensity * 0.85).toFixed(3)})`;
        ctx.fill();
      });
    });

    // Grid and blips on top of intensity
    this.drawRadarBg(ctx, cx, cy, R, '#0a1420', '#1a73e8');
    this.drawTargetBlips(ctx, cx, cy, R, true);

    ctx.fillStyle = 'rgba(26,115,232,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PHASED ARRAY BEAMFORMING', cx, H - 6);

    // Match detections to targets by target_id
    const detectedIds = new Set(result.detections.map((d: any) => d.target_id));
    this.targets = this.targets.map((tgt) => {
      const hit = detectedIds.has(tgt.id);
      return hit ? { ...tgt, detected: true, blipAge: 0 } : { ...tgt, detected: tgt.blipAge < 120 };
    });
    this.detectedCount = result.detections.length;
    this.cdr.markForCheck();
  }

  // ── Beamforming canvas: fallback paint (runs every frame) ──────

  private drawBeamformingFallback(): void {
    const canvas = this.bfCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    // Fade previous frame
    ctx.fillStyle = 'rgba(2,10,20,0.08)';
    ctx.fillRect(0, 0, W, H);

    this.drawRadarBg(ctx, cx, cy, R, '#0a1420', '#1a73e8');

    // Animated beam cone — shows sweep direction at all times
    const angleRad = ((this.scanAngle - 90) * Math.PI) / 180;
    const halfRad = ((this.beamWidth / 2) * Math.PI) / 180;

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

    // Beam axis line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(100,200,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = '#64c8ff';
    ctx.shadowBlur = 10;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Angle label
    ctx.fillStyle = 'rgba(100,200,255,0.8)';
    ctx.font = '9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    const lx = cx + (R + 12) * Math.cos(angleRad);
    const ly = cy + (R + 12) * Math.sin(angleRad);
    ctx.fillText(`${this.scanAngle.toFixed(0)}°`, lx, ly);

    this.drawTargetBlips(ctx, cx, cy, R, true);
  }

  // ── Traditional radar canvas ───────────────────────────────────

  private drawTraditional(): void {
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

  // ── Shared helpers ─────────────────────────────────────────────

  private toCartesian(t: RadarTarget) {
    const r = t.range * this.maxRangeM;
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
    bgColor: string,
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
   * useBeam=true  → reads blipAge     / phased-array state
   * useBeam=false → reads trdBlipAge  / traditional state
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
      // Blip radius scales with RCS — bigger body = bigger blip
      const radius = 3 + tgt.rcs * 0.25;

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
            .padStart(2, '0');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (alpha > 0.2) {
        ctx.fillStyle =
          color +
          Math.round(alpha * 200)
            .toString(16)
            .padStart(2, '0');
        ctx.font = '8px IBM Plex Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(tgt.label, tx + 6, ty - 3);
      }
    });
  }
}
