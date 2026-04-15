// ══════════════════════════════════════════════════════════════════
//  ModeUltrasoundComponent  (refactored)
//
//  Layout:
//    • Toolbar  – preset selector + global recompute button
//    • Left col – Probe Array sidebar  (app-probe-array)
//    • Centre   – Wavefront propagation canvas  (animated)
//               – B-Mode image canvas           (animated mock)
//    • Right    – BeamformingViewer             (app-beamforming-viewer)
//                   Panel 1: probe array mirror (driven by shared config)
//                   Panel 2: interference map
//                   Panel 3: beam profile + IFFT strip
//    • Bottom   – Metrics strip
//
//  The two components share `arrayConfig` via:
//    • @Input() initialConfig  on BeamformingViewerComponent
//    • (configChange) output   feeds back into the local arrayConfig
//      so both canvases stay in sync.
// ══════════════════════════════════════════════════════════════════

import {
  Component, OnInit, OnDestroy, ViewChild, ElementRef,
  ChangeDetectionStrategy, ChangeDetectorRef, Input, Output, EventEmitter
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule }  from '@angular/forms';

import { ProbeArrayComponent }       from '../../probe-array/probe-array.component';
import { BeamformingViewerComponent } from '../../beamforming-viewer/beamforming-viewer.component';
import { InterferenceFieldComponent, ElementPosition } from '../../interference-field/interference-field.component';
import {
  ArrayConfig, BeamformingResult, ScenarioPreset,
  PREDEFINED_SCENARIOS, makeDefaultArrayConfig,
} from '../../../models/beamforming.models';

@Component({
  selector       : 'app-mode-ultrasound',
  standalone     : true,
  imports        : [
    CommonModule,
    FormsModule,
    ProbeArrayComponent,
    BeamformingViewerComponent,
    InterferenceFieldComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './mode-ultrasound.component.html',
  styleUrls      : ['./mode-ultrasound.component.css'],
})
export class ModeUltrasoundComponent implements OnInit, OnDestroy {
  // ── Canvas refs ─────────────── ─────────────────────────────────
  @ViewChild('propCanvas',  { static: true }) propCanvasRef!  : ElementRef<HTMLCanvasElement>;
  @ViewChild('depthCanvas', { static: true }) depthCanvasRef! : ElementRef<HTMLCanvasElement>;

  // ── State ──────────────────────────────────────────────────────
  arrayConfig    : ArrayConfig          = makeDefaultArrayConfig(6);
  beamResult     : BeamformingResult | null = null;
  selectedPreset : string               = '';

  ultrasoundPresets: ScenarioPreset[] =
    PREDEFINED_SCENARIOS.filter(s => s.mode === 'ultrasound');

  private animId : number = 0;
  private t      : number = 0;

  constructor(private cdr: ChangeDetectorRef) {}

  // ── Lifecycle ─────────────────────────────────────────────────

  ngOnInit(): void {
    this.startAnimation();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
  }

  // ── Preset loader ─────────────────────────────────────────────

  loadPreset(name: string): void {
    const preset = this.ultrasoundPresets.find(p => p.name === name);
    if (!preset) return;
    // Spread so the BeamformingViewer detects the reference change
    this.arrayConfig = { ...preset.array };
    this.cdr.markForCheck();
  }

  // ── Shared config handlers ────────────────────────────────────

  /**
   * Called by <app-probe-array> in the sidebar.
   * Propagates to <app-beamforming-viewer> via [initialConfig] binding.
   */
  onArrayConfigChange(cfg: ArrayConfig): void {
    this.arrayConfig = cfg;
    this.cdr.markForCheck();
  }

  /**
   * Called by <app-beamforming-viewer> when its internal probe array
   * is modified. Keeps the sidebar probe array in sync.
   */
  onViewerConfigChange(cfg: ArrayConfig): void {
    this.arrayConfig = cfg;
    this.cdr.markForCheck();
  }

  /**
   * Receives beam metrics from the sidebar probe array so the
   * metrics strip stays populated even if the viewer hasn't computed yet.
   */
  onBeamResult(r: BeamformingResult): void {
    this.beamResult = r;
    this.cdr.markForCheck();
  }

  // ── Interference field positions (for <app-interference-field>) ─

  get interferencePositions(): ElementPosition[] {
    const W      = 400;
    const startY = 60;
    return this._elementPositions(W, startY).map((pos, i) => ({
      x     : pos.x,
      y     : pos.y,
      config: this.arrayConfig.elements[i],
    }));
  }

  // ── Animation loop ────────────────────────────────────────────

  private startAnimation(): void {
    const loop = () => {
      this.t    += 0.025;
      this.drawPropagation();
      this.drawDepthMap();
      this.animId = requestAnimationFrame(loop);
    };
    loop();
  }

  // ── Element position helper ───────────────────────────────────

  private _elementPositions(W: number, startY: number): { x: number; y: number }[] {
    const cfg = this.arrayConfig;
    const n   = cfg.elements.length;
    const d   = cfg.elementSpacing * 1.5;
    const R   = cfg.curvatureRadius;
    const cx  = W / 2;

    const raw = cfg.elements.map((_, i) => {
      const offset = (i - (n - 1) / 2) * d;
      if (cfg.geometry === 'linear') {
        return { x: cx + offset, y: startY };
      } else {
        const angleRad = offset / R;
        return {
          x: cx + R * Math.sin(angleRad) * 1.5,
          y: startY - R * (1 - Math.cos(angleRad)) * 0.8,
        };
      }
    });

    // Clamp to 90 % of canvas width
    const margin  = W * 0.05;
    const minX    = Math.min(...raw.map(p => p.x));
    const maxX    = Math.max(...raw.map(p => p.x));
    const spanX   = maxX - minX;
    const maxSpan = W - margin * 2;

    let clamped = raw;
    if (spanX > maxSpan) {
      const scale = maxSpan / spanX;
      const midX  = (minX + maxX) / 2;
      clamped = raw.map(p => ({
        x: cx + (p.x - midX) * scale,
        y: startY - (startY - p.y) * scale,
      }));
    }

    const minY = Math.min(...clamped.map(p => p.y));
    if (minY < 10) {
      const shiftY = 10 - minY;
      return clamped.map(p => ({ x: p.x, y: p.y + shiftY }));
    }
    return clamped;
  }

  // ── Propagation canvas ────────────────────────────────────────

  private drawPropagation(): void {
    const canvas = this.propCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx)  return;

    const W = canvas.width  = canvas.offsetWidth  || 400;
    const H = canvas.height = canvas.offsetHeight || 300;

    ctx.clearRect(0, 0, W, H);

    // Tissue background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0,   '#e8f4e8');
    bg.addColorStop(0.3, '#d4eacc');
    bg.addColorStop(1,   '#a8c89a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const cfg     = this.arrayConfig;
    const startY  = 60;
    const positions = this._elementPositions(W, startY);

    // Wavefronts per element
    cfg.elements.forEach((el, i) => {
      if (!el.enabled) return;

      const elX      = positions[i].x;
      const elY      = positions[i].y;
      const delay    = el.timeDelay;
      const phaseOff = (el.phaseShift * Math.PI) / 180;

      for (let ring = 0; ring < 5; ring++) {
        const r = ((this.t * 60 - delay * 8 + ring * 28 + phaseOff * 6) % 160);
        if (r < 0) continue;
        const alpha = Math.max(0, (1 - r / 160)) * (el.intensity / 100) * 0.5;
        ctx.beginPath();
        ctx.arc(elX, elY, r, 0, Math.PI);
        ctx.strokeStyle = el.color + Math.round(alpha * 255).toString(16).padStart(2, '0');
        ctx.lineWidth   = 1;
        ctx.stroke();
      }

      // Element rect
      ctx.fillStyle = el.color;
      ctx.fillRect(elX - 5, elY - 8, 10, 6);
    });

    this.drawFocusedBeam(ctx, W, H, startY);
    this.drawTissueLayers(ctx, W, H);

    // Focus point pulse
    const focusY = startY + cfg.focusDepth * 1.5;
    if (cfg.focusDepth > 0 && focusY < H) {
      const cx    = W / 2 + Math.sin((cfg.steeringAngle * Math.PI) / 180) * focusY;
      const pulse = 0.7 + 0.3 * Math.sin(this.t * 8);
      ctx.beginPath();
      ctx.arc(cx, focusY, 6 * pulse, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(255,200,0,0.4)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,200,0,0.9)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }
  }

  private drawFocusedBeam(
    ctx    : CanvasRenderingContext2D,
    W      : number,
    H      : number,
    startY : number,
  ): void {
    const cfg       = this.arrayConfig;
    const angleRad  = (cfg.steeringAngle * Math.PI) / 180;
    const positions = this._elementPositions(W, startY);
    const cx        = positions.reduce((s, p) => s + p.x, 0) / positions.length;
    const focusLen  = cfg.focusDepth > 0
      ? Math.min(cfg.focusDepth * 1.5, H - startY - 10)
      : H - startY - 10;

    const grad = ctx.createLinearGradient(
      cx, startY,
      cx + Math.sin(angleRad) * focusLen, startY + focusLen,
    );
    grad.addColorStop(0,   'rgba(26,115,232,0.0)');
    grad.addColorStop(0.4, 'rgba(26,115,232,0.25)');
    grad.addColorStop(1,   'rgba(26,115,232,0.0)');

    const halfW = Math.max(8, 30 - cfg.numElements * 1.5);

    ctx.beginPath();
    ctx.moveTo(cx - halfW, startY);
    ctx.lineTo(cx + Math.sin(angleRad) * focusLen - halfW * 0.3, startY + focusLen);
    ctx.lineTo(cx + Math.sin(angleRad) * focusLen + halfW * 0.3, startY + focusLen);
    ctx.lineTo(cx + halfW, startY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(26,115,232,0.7)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.moveTo(cx, startY);
    ctx.lineTo(cx + Math.sin(angleRad) * focusLen, startY + focusLen);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawTissueLayers(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const layers = [
      { y: H * 0.30, label: 'Subcutaneous fat', color: 'rgba(255,220,150,0.3)' },
      { y: H * 0.55, label: 'Muscle',           color: 'rgba(200,100,100,0.2)' },
      { y: H * 0.75, label: 'Organ tissue',     color: 'rgba(150,200,150,0.2)' },
    ];
    layers.forEach(layer => {
      ctx.fillStyle = layer.color;
      ctx.fillRect(0, layer.y, W, 2);
      ctx.fillStyle = 'rgba(100,120,100,0.5)';
      ctx.font      = '9px IBM Plex Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(layer.label, W - 6, layer.y - 2);
    });
  }

  // ── B-Mode canvas ─────────────────────────────────────────────

  private drawDepthMap(): void {
    const canvas = this.depthCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx)  return;

    const W = canvas.width  = canvas.offsetWidth  || 200;
    const H = canvas.height = canvas.offsetHeight || 300;

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0a0a');
    bg.addColorStop(1, '#1a2030');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const cfg              = this.arrayConfig;
    const angleRad         = (cfg.steeringAngle * Math.PI) / 180;
    const enabledElements  = cfg.elements.filter(el => el.enabled);
    const avgIntensity     = enabledElements.length > 0
      ? enabledElements.reduce((s, el) => s + el.intensity, 0) / enabledElements.length
      : 80;

    for (let x = 0; x < W; x++) {
      const lateralNorm = (x / W - 0.5) * 2;
      for (let y = 10; y < H; y++) {
        const depth      = y / H;
        const noise      = Math.random();
        const tissueVal  = Math.sin(y * 0.15 + this.t * 0.1) * 0.5 + 0.5;
        const focus      = Math.exp(-Math.pow(lateralNorm - Math.sin(angleRad) * depth, 2) * 20);
        const val        = tissueVal * focus * (1 - depth * 0.5) * avgIntensity / 100;

        if (noise > 0.85 && val > 0.1) {
          ctx.fillStyle = `rgba(${Math.round(val * 200)},${Math.round(val * 220)},${Math.round(val * 200)},${val})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // Focus zone
    if (cfg.focusDepth > 0) {
      const fy = (cfg.focusDepth / 200) * H;
      ctx.strokeStyle = 'rgba(255,200,0,0.5)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, fy); ctx.lineTo(W, fy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,200,0,0.7)';
      ctx.font      = '8px IBM Plex Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`F ${cfg.focusDepth}mm`, 4, fy - 2);
    }

    ctx.fillStyle = 'rgba(100,140,200,0.7)';
    ctx.font      = '9px IBM Plex Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('B-MODE', W - 4, 12);
  }
}