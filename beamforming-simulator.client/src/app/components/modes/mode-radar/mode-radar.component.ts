// ══════════════════════════════════════════════════════════════════
//  ModeRadarComponent
//  Phased-array radar beamforming simulator:
//    • Circular scan field
//    • Beam steered by per-element phase delays (not rotating line)
//    • Target placement + detection
//    • Side-by-side: beamforming scan vs traditional rotating radar
// ══════════════════════════════════════════════════════════════════

import {
  Component, OnInit, OnDestroy, ViewChild, ElementRef,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule }  from '@angular/common';
import { FormsModule }   from '@angular/forms';

import { ProbeArrayComponent } from '../../probe-array/probe-array.component';
import { BeamformingService }  from '../../../services/beamforming.service';
import {
  ArrayConfig, makeDefaultArrayConfig, PREDEFINED_SCENARIOS,
} from '../../../models/beamforming.models';
import { InterferenceFieldComponent, ElementPosition } from '../../interference-field/interference-field.component';
interface RadarTarget {
  id      : string;
  angle   : number;   // degrees from north (0–360)
  range   : number;   // 0–1 (fraction of radius)
  detected: boolean;
  label   : string;
  rcs     : number;   // radar cross-section (arbitrary)
  blipAge : number;   // frames since last detection
}

@Component({
  selector       : 'app-mode-radar',
  standalone     : true,
  imports        : [CommonModule, FormsModule, ProbeArrayComponent, InterferenceFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './mode-radar.component.html',
  styleUrls      : ['./mode-radar.component.css'],
})
export class ModeRadarComponent implements OnInit, OnDestroy {

  @ViewChild('bfCanvas',  { static: true }) bfCanvasRef!  : ElementRef<HTMLCanvasElement>;
  @ViewChild('trdCanvas', { static: true }) trdCanvasRef! : ElementRef<HTMLCanvasElement>;

  arrayConfig  : ArrayConfig = makeDefaultArrayConfig(12);
  targets      : RadarTarget[] = [];
  scanAngle    : number = 0;         // current beam angle (degrees)
  scanSpeed    : number = 1.2;       // degrees per frame
  scanRange    : number = 1;         // full range (0–1)
  scanDirection: number = 1;         // +1 cw, -1 ccw
  sweepMode    : 'sector' | 'full'  = 'full';
  sectorMin    : number = -60;
  sectorMax    : number =  60;
  detectedCount: number = 0;

  // Traditional radar state
  private trdAngle: number = 0;

  private animId : number = 0;
  private t      : number = 0;
  // Persistence layer: fading trail pixels
  private bfTrail : ImageData | null = null;

  constructor(
    private beamSvc: BeamformingService,
    private cdr    : ChangeDetectorRef,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────

  ngOnInit(): void {
    // Load radar preset
    const preset = PREDEFINED_SCENARIOS.find(s => s.mode === 'radar');
    if (preset) this.arrayConfig = { ...preset.array };

    // Place some default targets
    this.targets = [
      { id:'t1', angle:35,  range:0.55, detected:false, label:'TGT-A', rcs:5,  blipAge:999 },
      { id:'t2', angle:120, range:0.7,  detected:false, label:'TGT-B', rcs:3,  blipAge:999 },
      { id:'t3', angle:220, range:0.4,  detected:false, label:'TGT-C', rcs:8,  blipAge:999 },
      { id:'t4', angle:310, range:0.65, detected:false, label:'TGT-D', rcs:2,  blipAge:999 },
    ];

    this.startAnimation();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
  }

  // ── Controls ───────────────────────────────────────────────────
  get interferencePositions(): ElementPosition[] {
    const W  = 360;
    const H  = 360;
    const cx = W / 2;
    const cy = H / 2;
    const n  = this.arrayConfig.elements.length;
    const d  = this.arrayConfig.elementSpacing * 2;

    return this.arrayConfig.elements.map((el, i) => ({
      x     : cx + (i - (n - 1) / 2) * d,
      y     : cy,
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
    const idx   = this.targets.length;
    this.targets = [...this.targets, {
      id      : `t${Date.now()}`,
      angle, range,
      detected: false,
      label   : `TGT-${String.fromCharCode(65 + idx % 26)}`,
      rcs     : 1 + Math.random() * 8,
      blipAge : 999,
    }];
    this.cdr.markForCheck();
  }

  removeTarget(id: string): void {
    this.targets = this.targets.filter(t => t.id !== id);
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
      this.checkDetections();
      this.drawBeamforming();
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
        this.scanAngle  = this.sectorMax;
        this.scanDirection = -1;
      }
      if (this.scanAngle <= this.sectorMin) {
        this.scanAngle  = this.sectorMin;
        this.scanDirection = 1;
      }
    }

    this.trdAngle = (this.trdAngle + this.scanSpeed * 0.8) % 360;
  }

  private checkDetections(): void {
    // Beamwidth = 180 / numElements degrees (approx)
    const halfBeam = 90 / Math.max(this.arrayConfig.numElements, 2);
    let detected   = 0;

    this.targets = this.targets.map(tgt => {
      tgt.blipAge++;
      let angleDiff = ((tgt.angle - this.scanAngle) + 360) % 360;
      if (angleDiff > 180) angleDiff = 360 - angleDiff;
      const inBeam = angleDiff < halfBeam && tgt.range <= this.scanRange;
      if (inBeam) {
        tgt.detected = true;
        tgt.blipAge  = 0;
        detected++;
      } else if (tgt.blipAge > 120) {
        tgt.detected = false;
      }
      return { ...tgt };
    });

    this.detectedCount = detected;
  }

  // ── Beamforming radar canvas ───────────────────────────────────

  private drawBeamforming(): void {
    const canvas = this.bfCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W  = canvas.width  = canvas.offsetWidth  || 360;
    const H  = canvas.height = canvas.offsetHeight || 360;
    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) / 2 - 16;

    // Fade previous frame (persistence effect)
    ctx.fillStyle = 'rgba(2,10,20,0.08)';
    ctx.fillRect(0, 0, W, H);

    // Background
    this.drawRadarBg(ctx, cx, cy, R, '#0a1420', '#1a73e8');

    // Draw beam sweep
    this.drawBeamSweep(ctx, cx, cy, R);

    // Draw targets
    this.drawTargetBlips(ctx, cx, cy, R, true);

    // Label
    ctx.fillStyle = 'rgba(26,115,232,0.7)';
    ctx.font      = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PHASED ARRAY BEAMFORMING', cx, H - 6);
  }

  private drawBeamSweep(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    const angleRad  = ((this.scanAngle - 90) * Math.PI) / 180;
    const halfBeam  = (90 / Math.max(this.arrayConfig.numElements, 2)) * Math.PI / 180;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angleRad - halfBeam, angleRad + halfBeam);
    ctx.closePath();

    // Gradient from center
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    rg.addColorStop(0, 'rgba(26,115,232,0.6)');
    rg.addColorStop(0.7, 'rgba(26,115,232,0.25)');
    rg.addColorStop(1, 'rgba(26,115,232,0.0)');
    ctx.fillStyle = rg;
    ctx.fill();

    // Beam edge lines
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(26,115,232,0.9)';
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = '#1a73e8';
    ctx.shadowBlur  = 10;
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + R * Math.cos(angleRad - halfBeam),
      cy + R * Math.sin(angleRad - halfBeam),
    );
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + R * Math.cos(angleRad + halfBeam),
      cy + R * Math.sin(angleRad + halfBeam),
    );
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Centre beam axis
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(100,200,255,0.95)';
    ctx.lineWidth   = 2;
    ctx.shadowColor = '#64c8ff';
    ctx.shadowBlur  = 12;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Angle label
    ctx.fillStyle = 'rgba(100,200,255,0.8)';
    ctx.font      = '9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    const lx = cx + (R + 12) * Math.cos(angleRad);
    const ly = cy + (R + 12) * Math.sin(angleRad);
    ctx.fillText(`${this.scanAngle.toFixed(0)}°`, lx, ly);
  }

  // ── Traditional radar canvas ───────────────────────────────────

  private drawTraditional(): void {
    const canvas = this.trdCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W  = canvas.width  = canvas.offsetWidth  || 360;
    const H  = canvas.height = canvas.offsetHeight || 360;
    const cx = W / 2, cy = H / 2;
    const R  = Math.min(W, H) / 2 - 16;

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
    ctx.lineWidth   = 2;
    ctx.shadowColor = '#34a853';
    ctx.shadowBlur  = 10;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.stroke();
    ctx.shadowBlur = 0;

    this.drawTargetBlips(ctx, cx, cy, R, false);

    ctx.fillStyle = 'rgba(52,168,83,0.7)';
    ctx.font      = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TRADITIONAL ROTATING SWEEP', cx, H - 6);
  }

  // ── Shared radar drawing helpers ───────────────────────────────

  private drawRadarBg(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number,
    bgColor: string, lineColor: string,
  ): void {
    // Clip circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // Rings
    [0.25, 0.5, 0.75, 1].forEach(frac => {
      ctx.beginPath();
      ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
      ctx.strokeStyle = lineColor + '25';
      ctx.lineWidth   = 1;
      ctx.stroke();
    });

    // Cross-hairs
    ctx.strokeStyle = lineColor + '20';
    ctx.lineWidth   = 0.5;
    [-1,0,1].forEach(i => {
      ctx.beginPath();
      ctx.moveTo(cx + i * R / 2, cy - R);
      ctx.lineTo(cx + i * R / 2, cy + R);
      ctx.moveTo(cx - R, cy + i * R / 2);
      ctx.lineTo(cx + R, cy + i * R / 2);
      ctx.stroke();
    });

    ctx.restore();

    // Outer ring border
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = lineColor + '55';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Range labels
    ctx.fillStyle = lineColor + '55';
    ctx.font      = '8px IBM Plex Mono, monospace';
    ctx.textAlign = 'right';
    [25, 50, 75, 100].forEach((km, i) => {
      ctx.fillText(`${km}km`, cx - 3, cy - R * ((i + 1) / 4) + 3);
    });
  }

  private drawTargetBlips(
    ctx     : CanvasRenderingContext2D,
    cx      : number, cy: number, R: number,
    useBeam : boolean,
  ): void {
    this.targets.forEach(tgt => {
      const angleRad  = ((tgt.angle - 90) * Math.PI) / 180;
      const tx        = cx + tgt.range * R * Math.cos(angleRad);
      const ty        = cy + tgt.range * R * Math.sin(angleRad);
      const freshness = Math.max(0, 1 - tgt.blipAge / 150);
      const alpha     = useBeam ? freshness : Math.max(0, 1 - tgt.blipAge / 80);

      if (alpha < 0.02) return;

      const color = useBeam ? '#64c8ff' : '#a0ffa0';

      // Blip
      ctx.beginPath();
      ctx.arc(tx, ty, 4 + tgt.rcs * 0.3, 0, Math.PI * 2);
      ctx.fillStyle   = color + Math.round(alpha * 200).toString(16).padStart(2, '0');
      ctx.fill();
      ctx.strokeStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0');
      ctx.lineWidth   = 1;
      ctx.stroke();

      // Ring ping when freshly detected
      if (tgt.blipAge < 20) {
        const pingR = tgt.blipAge * 2;
        ctx.beginPath();
        ctx.arc(tx, ty, pingR, 0, Math.PI * 2);
        ctx.strokeStyle = color + Math.round((1 - tgt.blipAge / 20) * 200).toString(16).padStart(2, '0');
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }

      // Label
      if (alpha > 0.2) {
        ctx.fillStyle = color + Math.round(alpha * 200).toString(16).padStart(2, '0');
        ctx.font      = '8px IBM Plex Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(tgt.label, tx + 6, ty - 3);
      }
    });
  }
}
