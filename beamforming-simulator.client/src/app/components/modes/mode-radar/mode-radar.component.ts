// ══════════════════════════════════════════════════════════════════
//  ModeRadarComponent
//  Phased-array radar beamforming simulator:
//    • Circular scan field
//    • Beam steered by per-element phase delays (not rotating line)
//    • Target placement + detection
//    • Side-by-side: beamforming scan vs traditional rotating radar
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
  id: string; // frontend identity (matches target_id sent to backend)
  angle: number;
  range: number; // 0–1 fraction of maxRangeM
  rcs: number;
  label: string;
  detected: boolean; // set by applyBackendResult, not checkDetections
  blipAge: number; // incremented locally between scans for fade-out
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

  arrayConfig: ArrayConfig = makeDefaultArrayConfig(12);
  targets: RadarTarget[] = [];
  scanAngle: number = 0; // current beam angle (degrees)
  scanSpeed: number = 1.2; // degrees per frame
  scanRange: number = 1; // full range (0–1)
  scanDirection: number = 1; // +1 cw, -1 ccw
  sweepMode: 'sector' | 'full' = 'full';
  sectorMin: number = -60;
  sectorMax: number = 60;
  detectedCount: number = 0;

  // Traditional radar state
  private trdAngle: number = 0;

  private animId: number = 0;
  private t: number = 0;

  private readonly maxRangeM = 100;
  private radarReady = false;

  constructor(
    private beamSvc: BeamformingService,
    private cdr: ChangeDetectorRef,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────

  ngOnInit(): void {
    const preset = PREDEFINED_SCENARIOS.find((s) => s.mode === 'radar');
    if (preset) this.arrayConfig = { ...preset.array };

    this.targets = [
      { id: 't1', angle: 35, range: 0.55, detected: false, label: 'TGT-A', rcs: 5, blipAge: 999 },
      { id: 't2', angle: 120, range: 0.7, detected: false, label: 'TGT-B', rcs: 3, blipAge: 999 },
      { id: 't3', angle: 220, range: 0.4, detected: false, label: 'TGT-C', rcs: 8, blipAge: 999 },
      { id: 't4', angle: 310, range: 0.65, detected: false, label: 'TGT-D', rcs: 2, blipAge: 999 },
    ];

    // Always start the animation immediately — canvas must never be black
    this.startAnimation();

    // Setup radar in parallel; if it fails, scans are skipped gracefully
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

  // ── Controls ───────────────────────────────────────────────────
  get interferencePositions(): ElementPosition[] {
    const W = 360;
    const H = 360;
    const cx = W / 2;
    const cy = H / 2;
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
    const angle = Math.random() * 360;
    const range = 0.3 + Math.random() * 0.6;
    const idx = this.targets.length;
    this.targets = [
      ...this.targets,
      {
        id: `t${Date.now()}`,
        angle,
        range,
        detected: false,
        label: `TGT-${String.fromCharCode(65 + (idx % 26))}`,
        rcs: 1 + Math.random() * 8,
        blipAge: 999,
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

  // ── Animation ──────────────────────────────────────────────────

  private startAnimation(): void {
    const loop = () => {
      this.t += 1;
      this.advanceScan();
      this.targets = this.targets.map((t) => ({ ...t, blipAge: t.blipAge + 1 }));

      if (this.t % 6 === 0) {
        this.requestBackendScan();
      }

      // Always paint the beamforming canvas locally —
      // applyBackendResult will overdraw this when backend responds
      this.drawBeamformingFallback();
      this.drawTraditional();
      this.animId = requestAnimationFrame(loop);
    };
    loop();
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

    this.trdAngle = (this.trdAngle + this.scanSpeed * 0.8) % 360;
  }

  // ── Beamforming radar canvas ───────────────────────────────────

  private requestBackendScan(): void {
    if (!this.radarReady) return; // ← skip silently until setup succeeds
    const sweepHalf = 15;
    this.beamSvc
      .scanRadar({
        start_angle: this.scanAngle - sweepHalf,
        end_angle: this.scanAngle + sweepHalf,
        num_lines: 32,
        max_range_m: this.maxRangeM,
        targets: this.targets.map((t) => this.toCartesian(t)),
      })
      .subscribe((result) => this.applyBackendResult(result));
  }

  private applyBackendResult(result: { ppi_image_base64: string; detections: any[] }): void {
    // 1. Draw the backend PPI image slice onto the beamforming canvas
    const canvas = this.bfCanvasRef?.nativeElement;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const W = canvas.width || 360;
        const H = canvas.height || 360;
        const cx = W / 2,
          cy = H / 2;
        const R = Math.min(W, H) / 2 - 16;

        const img = new Image();
        img.onload = () => {
          // Fade previous frame
          ctx.fillStyle = 'rgba(2,10,20,0.08)';
          ctx.fillRect(0, 0, W, H);

          // Clip to radar circle and stamp PPI slice
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, R, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, cx - R, cy - R, R * 2, R * 2);
          ctx.restore();

          // Grid / rings on top
          this.drawRadarBg(ctx, cx, cy, R, '#0a1420', '#1a73e8');

          // Blips driven by backend detections
          this.drawTargetBlips(ctx, cx, cy, R, true);

          ctx.fillStyle = 'rgba(26,115,232,0.7)';
          ctx.font = 'bold 9px IBM Plex Mono, monospace';
          ctx.textAlign = 'center';
          ctx.fillText('PHASED ARRAY BEAMFORMING', cx, H - 6);

          this.cdr.markForCheck();
        };
        img.src = result.ppi_image_base64;
      }
    }

    // 2. Match detections back to targets by target_id
    const detectedIds = new Set(result.detections.map((d: any) => d.target_id ?? null));
    // Note: detections currently carry range_m/angle_deg, not target_id.
    // Until backend echoes target_id, fall back to angle proximity:
    const detectedAngles: number[] = result.detections.map((d: any) => d.angle_deg);

    this.targets = this.targets.map((tgt) => {
      const hit = detectedAngles.some((a) => Math.abs(a - tgt.angle) < 5);
      return hit ? { ...tgt, detected: true, blipAge: 0 } : { ...tgt, detected: tgt.blipAge < 120 };
    });

    this.detectedCount = result.detections.length;
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

    // Fade
    ctx.fillStyle = 'rgba(2,10,10,0.08)';
    ctx.fillRect(0, 0, W, H);

    this.drawRadarBg(ctx, cx, cy, R, '#0a1410', '#34a853');

    // Simple rotating sweep line
    const angleRad = ((this.trdAngle - 90) * Math.PI) / 180;

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

    ctx.fillStyle = 'rgba(2,10,20,0.08)';
    ctx.fillRect(0, 0, W, H);

    this.drawRadarBg(ctx, cx, cy, R, '#0a1420', '#1a73e8');
    this.drawTargetBlips(ctx, cx, cy, R, true);

    ctx.fillStyle = 'rgba(26,115,232,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PHASED ARRAY BEAMFORMING', cx, H - 6);
  }

  // ── Shared radar drawing helpers ───────────────────────────────

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
    // Clip circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // Rings
    [0.25, 0.5, 0.75, 1].forEach((frac) => {
      ctx.beginPath();
      ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
      ctx.strokeStyle = lineColor + '25';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // Cross-hairs
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

    // Outer ring border
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = lineColor + '55';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Range labels
    ctx.fillStyle = lineColor + '55';
    ctx.font = '8px IBM Plex Mono, monospace';
    ctx.textAlign = 'right';
    [25, 50, 75, 100].forEach((km, i) => {
      ctx.fillText(`${km}km`, cx - 3, cy - R * ((i + 1) / 4) + 3);
    });
  }

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
      const freshness = Math.max(0, 1 - tgt.blipAge / 150);
      const alpha = useBeam ? freshness : Math.max(0, 1 - tgt.blipAge / 80);

      if (alpha < 0.02) return;

      const color = useBeam ? '#64c8ff' : '#a0ffa0';

      // Blip
      ctx.beginPath();
      ctx.arc(tx, ty, 4 + tgt.rcs * 0.3, 0, Math.PI * 2);
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

      // Ring ping when freshly detected
      if (tgt.blipAge < 20) {
        const pingR = tgt.blipAge * 2;
        ctx.beginPath();
        ctx.arc(tx, ty, pingR, 0, Math.PI * 2);
        ctx.strokeStyle =
          color +
          Math.round((1 - tgt.blipAge / 20) * 200)
            .toString(16)
            .padStart(2, '0');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Label
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
