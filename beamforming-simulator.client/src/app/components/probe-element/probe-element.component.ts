// ══════════════════════════════════════════════════════════════════
//  ProbeElementComponent
//  Self-contained probe element with:
//    • Parameter controls (phase, delay, frequency, intensity)
//    • Canvas-based wave visualisation
//    • Emits config changes to parent via @Output
// ══════════════════════════════════════════════════════════════════

import {
  Component, Input, Output, EventEmitter,
  OnInit, OnChanges, OnDestroy,
  ViewChild, ElementRef, ChangeDetectionStrategy,
  SimpleChanges,
} from '@angular/core';
import { CommonModule }      from '@angular/common';
import { FormsModule }       from '@angular/forms';
import { ProbeElementConfig } from '../../models/beamforming.models';

@Component({
  selector       : 'app-probe-element',
  standalone     : true,
  imports        : [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './probe-element.component.html',
  styleUrls      : ['./probe-element.component.css'],
})
export class ProbeElementComponent implements OnInit, OnChanges, OnDestroy {

  @Input()  config!    : ProbeElementConfig;
  @Input()  compact    : boolean = false;   // condensed layout for array view
  @Input()  selected   : boolean = false;
  @Output() configChange = new EventEmitter<ProbeElementConfig>();
  @Output() selectEl     = new EventEmitter<string>();
  @Output() deleteEl     = new EventEmitter<string>();

  @ViewChild('waveCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  private animFrameId : number = 0;
  private phase       : number = 0;          // animation phase accumulator

  // ── Lifecycle ─────────────────────────────────────────────────

  ngOnInit(): void {
    this.startAnimation();
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['config'] && !ch['config'].firstChange) {
      // Config changed externally – redraw immediately
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animFrameId);
  }

  // ── Control handlers ──────────────────────────────────────────

  onParamChange(): void {
    this.configChange.emit({ ...this.config });
  }

  toggleEnabled(): void {
    this.config = { ...this.config, enabled: !this.config.enabled };
    this.configChange.emit(this.config);
  }

  onSelect(): void {
    this.selectEl.emit(this.config.id);
  }

  onDelete(ev: MouseEvent): void {
    ev.stopPropagation();
    this.deleteEl.emit(this.config.id);
  }

  // ── Wave canvas animation ─────────────────────────────────────

  private startAnimation(): void {
    const draw = () => {
      this.drawWave();
      this.phase += 0.05 * (this.config?.frequency ?? 5) / 5;
      this.animFrameId = requestAnimationFrame(draw);
    };
    draw();
  }

  private drawWave(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width  = canvas.offsetWidth  || 180;
    const H = canvas.height = canvas.offsetHeight ||  56;

    ctx.clearRect(0, 0, W, H);

    if (!this.config?.enabled) {
      // Flat disabled line
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(120,140,160,0.25)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const freq      = this.config.frequency;          // MHz  (visual cycles)
    const intensity = this.config.intensity / 100;    // 0-1
    const phaseRad  = (this.config.phaseShift * Math.PI) / 180;
    const apodW = this.config.apodizationWeight ?? 1;
    const amp       = (H / 2 - 4) * intensity;
    const cycles    = Math.max(1, Math.min(freq / 2, 6));
    const color     = this.config.color ?? '#1a73e8';

    // Background wave glow
    ctx.shadowColor = color;
    ctx.shadowBlur  = 6 * intensity;

    // Draw filled wave
    const grad = ctx.createLinearGradient(0, H / 2 - amp, 0, H / 2 + amp);
    grad.addColorStop(0, color + '55');
    grad.addColorStop(0.5, color + '22');
    grad.addColorStop(1, color + '55');

    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    for (let x = 0; x <= W; x++) {
      const t = (x / W) * cycles * 2 * Math.PI;
      const y = H / 2 - amp * Math.sin(t + this.phase + phaseRad);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H / 2);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw wave line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.shadowBlur  = 8 * intensity;
    for (let x = 0; x <= W; x++) {
      const t = (x / W) * cycles * 2 * Math.PI;
      const y = H / 2 - amp * Math.sin(t + this.phase + phaseRad);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw time-delay indicator (vertical line)
    if (this.config.timeDelay > 0) {
      const delayX = (this.config.timeDelay / 50) * W * 0.25;
      ctx.beginPath();
      ctx.strokeStyle = color + 'aa';
      ctx.lineWidth   = 1;
      ctx.setLineDash([2, 3]);
      ctx.moveTo(delayX, 4);
      ctx.lineTo(delayX, H - 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.shadowBlur = 0;
  }
}
