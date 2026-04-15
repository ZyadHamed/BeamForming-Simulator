import {
  Component, Input, OnChanges, OnDestroy,
  ViewChild, ElementRef, SimpleChanges,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProbeElementConfig } from '../../models/beamforming.models';

export interface ElementPosition {
  x       : number;   // pixels
  y       : number;   // pixels
  config  : ProbeElementConfig;
}

export type FieldGeometry = 'cartesian' | 'polar';

@Component({
  selector       : 'app-interference-field',
  standalone     : true,
  imports        : [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #canvas style="display:block;width:100%;height:100%;"></canvas>
  `,
  styles: [`:host { display:block; width:100%; height:100%; }`],
})
export class InterferenceFieldComponent implements OnChanges, OnDestroy {

  /** Physical element positions in canvas pixels + their configs */
  @Input() elementPositions : ElementPosition[] = [];
  /** 'cartesian' for ultrasound/5G, 'polar' for radar */
  @Input() fieldGeometry    : FieldGeometry = 'cartesian';
  /** Speed of wave propagation in pixels/unit — tune per mode */
  @Input() propagationSpeed : number = 1540;
  /** Colour tint for the field: 'blue' | 'green' | 'amber' */
  @Input() tint             : 'blue' | 'green' | 'amber' = 'blue';
  /** Resolution divisor — higher = faster but coarser (1=full, 2=half, 4=quarter) */
  @Input() resolution       : number = 3;

  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private animId   : number = 0;
  private t        : number = 0;
  private offscreen: OffscreenCanvas | null = null;

  ngOnChanges(ch: SimpleChanges): void {
    // Restart animation when inputs change
    cancelAnimationFrame(this.animId);
    this.startAnimation();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animId);
  }

  private startAnimation(): void {
    const draw = () => {
      this.t += 0.04;
      this.render();
      this.animId = requestAnimationFrame(draw);
    };
    draw();
  }

  private render(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width  = canvas.offsetWidth  || 300;
    const H = canvas.height = canvas.offsetHeight || 300;

    // Work at reduced resolution for performance
    const rW = Math.ceil(W / this.resolution);
    const rH = Math.ceil(H / this.resolution);

    // Compute interference field into ImageData
    const imageData = ctx.createImageData(rW, rH);
    const data      = imageData.data;

    const tintRgb = this.tint === 'blue'  ? [26, 115, 232]
                  : this.tint === 'green' ? [52, 168, 83]
                  :                         [232, 168, 43];

    const elements = this.elementPositions.filter(ep => ep.config.enabled);

    for (let py = 0; py < rH; py++) {
      for (let px = 0; px < rW; px++) {
        // Map reduced-res pixel back to full canvas coords
        const cx = (px / rW) * W;
        const cy = (py / rH) * H;

        let sumRe = 0;
        let sumIm = 0;

        for (const ep of elements) {
          const dx   = cx - ep.x;
          const dy   = cy - ep.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;

          const freq     = ep.config.frequency * 1e6;          // Hz
          const k        = (2 * Math.PI * freq) / this.propagationSpeed;
          const phaseRad = (ep.config.phaseShift * Math.PI) / 180;
          const delayRad = 2 * Math.PI * freq * ep.config.timeDelay * 1e-6;
          const amp      = (ep.config.intensity / 100) / dist;  // 1/r attenuation

          // Wave at this point: A/r * cos(k*dist - ω*t - φ - delay)
          const phase = k * dist - this.t * 3 - phaseRad - delayRad;
          sumRe += amp * Math.cos(phase);
          sumIm += amp * Math.sin(phase);
        }

        // Intensity = magnitude squared, normalised
        const intensity = Math.sqrt(sumRe * sumRe + sumIm * sumIm);
        const norm      = Math.min(intensity * 40, 1);   // scale factor

        const idx = (py * rW + px) * 4;
        data[idx]     = tintRgb[0];
        data[idx + 1] = tintRgb[1];
        data[idx + 2] = tintRgb[2];
        data[idx + 3] = Math.round(norm * 220);
      }
    }

    // Draw at reduced size then scale up
    const offCtx = document.createElement('canvas');
    offCtx.width  = rW;
    offCtx.height = rH;
    const off2d   = offCtx.getContext('2d')!;
    off2d.putImageData(imageData, 0, 0);

    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(offCtx, 0, 0, W, H);
  }
}