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
export class ModeRadarComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('bfCanvas', { static: true }) bfCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('trdCanvas', { static: true }) trdCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('patternCanvas', { static: false }) patternCanvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Public state ─────────────────────────────────────────────
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

  // Hardware capabilities mapping to the backend
  txPower: number = 70.0;
  prfHz: number = 1000.0;
  pulseWidthUs: number = 1.0;
  radarInfo: any = null;

  // ── Private state ─────────────────────────────────────────────
  private trdAngle: number = 0;
  private animId: number = 0;
  private radarReady: boolean = false;
  private backendBusy: boolean = false;
  private lastBackendAngle: number = 0;
  private lastRequestTime: number = 0;
  readonly maxRangeKm = 100;

  // Offscreen canvas for extreme rendering performance (Phosphor memory)
  private ppiCanvas!: HTMLCanvasElement;
  private ppiCtx!: CanvasRenderingContext2D;

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

  // Real-time frontend physics calculations
  get rangeResolutionM(): number {
    // c * τ / 2
    return 150 * this.pulseWidthUs;
  }

  get maxUnambRangeKm(): number {
    // c / (2 * PRF)
    return 3e8 / (2 * this.prfHz) / 1000;
  }

  get sideLobeLevel(): number {
    if (!this.radarInfo) return 0;
    return this.radarInfo.side_lobe_level ?? this.radarInfo.side_lobe_level_db ?? -13.5;
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
    ];

    this.beamSvc.setupRadar(this.buildRadarSetupRequest(this.arrayConfig)).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;
        this.cdr.markForCheck();
      },
      error: (e) => console.warn('Radar setup failed:', e),
    });
  }

  ngAfterViewInit(): void {
    // Initialize the offscreen canvas for caching radar blips
    this.ppiCanvas = document.createElement('canvas');
    this.ppiCtx = this.ppiCanvas.getContext('2d')!;
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
    // Re-trigger the backend setup when the user RELEASES a hardware dial
    this.beamSvc.setupRadar(this.buildRadarSetupRequest(this.arrayConfig)).subscribe({
      next: (res: any) => {
        this.radarReady = true;
        this.radarInfo = res;

        // Clear the phosphor screen on hardware change
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
      detected: false,
      blipAge: 999,
      trdDetected: false,
      trdBlipAge: 999,
    });
    this.cdr.markForCheck();
  }

  removeTarget(id: string): void {
    this.targets = this.targets.filter((t) => t.id !== id);
    this.cdr.markForCheck();
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

  private startAnimation(): void {
    this.zone.runOutsideAngular(() => {
      const loop = () => {
        this.advanceScan();
        this.checkTraditionalDetections(); // Re-activated Legacy Detection Check

        const now = Date.now();
        // Throttle backend calls to prevent network flooding and lag
        if (this.radarReady && !this.backendBusy && now - this.lastRequestTime > 200) {
          this.requestBackendScan();
        }

        this.applyPhosphorFade();
        this.drawBeamformingCanvas();
        this.drawTraditionalCanvas();

        // Only draw pattern canvas sporadically to save CPU
        if (now % 10 === 0) {
          this.drawPatternCanvas();
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
    this.trdAngle = (this.trdAngle + 0.6) % 360;

    // Age target detections so markers fade out
    this.targets.forEach((t) => t.blipAge++);
  }

  private checkTraditionalDetections(): void {
    // Legacy radar simulates a fixed 20-degree physical dish
    const halfBeam = 10;

    this.targets.forEach((tgt) => {
      tgt.trdBlipAge++;
      let diff = (tgt.angle - this.trdAngle + 360) % 360;
      if (diff > 180) diff = 360 - diff;

      if (diff < halfBeam && tgt.range <= this.scanRange) {
        tgt.trdDetected = true;
        tgt.trdBlipAge = 0;
      } else if (tgt.trdBlipAge > 100) {
        tgt.trdDetected = false;
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

  private requestBackendScan(): void {
    let startAngle = this.lastBackendAngle;
    let endAngle = this.scanAngle;

    if (endAngle < startAngle && startAngle - endAngle > 180) endAngle += 360;
    if (startAngle < endAngle && endAngle - startAngle > 180) startAngle += 360;

    const diff = Math.abs(endAngle - startAngle);
    if (diff < 0.5) return; // Don't scan if beam hasn't moved enough

    const numLines = Math.max(2, Math.min(30, Math.round(diff)));
    this.backendBusy = true;
    this.lastRequestTime = Date.now();

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

          // Paint raw physics data to the offscreen memory canvas immediately
          if (res?.sweep_data) {
            this.paintRawPhysicsToPhosphor(res.sweep_data);
          }

          if (res?.detections) {
            this.targets.forEach((tgt) => {
              const d = res.detections.find((x: any) => x.target_id === tgt.id);
              if (d) {
                tgt.detected = true;
                tgt.blipAge = 0;
              }
            });

            const newCount = this.targets.filter((t) => t.blipAge < 100).length;
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

  // --- SCIENTIFIC RENDERING ENGINE ---

  private applyPhosphorFade(): void {
    if (!this.ppiCtx) return;
    // Dim the entire offscreen canvas slightly every frame to simulate phosphor decay
    this.ppiCtx.fillStyle = 'rgba(0, 0, 0, 0.015)';
    this.ppiCtx.globalCompositeOperation = 'source-over';
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

    this.ppiCtx.globalCompositeOperation = 'lighter'; // Additive blending for overlapping beams

    sweep_data.forEach((line: any) => {
      const sweepRad = ((line.angle_deg - 90) * Math.PI) / 180;
      const bins = line.range_bins;
      const numBins = bins.length;

      for (let i = 0; i < numBins; i++) {
        const intensity = bins[i];
        if (intensity < 0.05) continue; // Filter out background noise

        const r0 = (i / numBins) * R;
        const r1 = ((i + 1) / numBins) * R;

        this.ppiCtx.beginPath();
        this.ppiCtx.arc(cx, cy, r1, sweepRad - halfRad, sweepRad + halfRad);
        this.ppiCtx.arc(cx, cy, r0, sweepRad + halfRad, sweepRad - halfRad, true);
        this.ppiCtx.closePath();

        // Scientific color map: Dark green to bright cyan
        const g = Math.floor(50 + intensity * 205);
        const b = Math.floor(intensity * 200);
        this.ppiCtx.fillStyle = `rgb(0, ${g}, ${b})`;
        this.ppiCtx.fill();
      }
    });
  }

  private drawBeamformingCanvas(): void {
    const canvas = this.bfCanvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false }); // Optimize
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 360);
    const H = (canvas.height = canvas.offsetHeight || 360);
    const cx = W / 2,
      cy = H / 2;
    const R = Math.min(W, H) / 2 - 16;

    // Sync offscreen canvas size
    if (this.ppiCanvas.width !== W) {
      this.ppiCanvas.width = W;
      this.ppiCanvas.height = H;
    }

    // 1. Solid Dark Background
    ctx.fillStyle = '#050a0f';
    ctx.fillRect(0, 0, W, H);

    // 2. Grid & Bearings
    this.drawRadarBg(ctx, cx, cy, R, 'rgba(26,115,232, 0.15)');

    // 3. Blit the Offscreen Phosphor Memory
    ctx.drawImage(this.ppiCanvas, 0, 0);

    // 4. Draw minimal sweep line indicator
    const angleRad = ((this.scanAngle - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.strokeStyle = 'rgba(26,115,232,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 5. Draw Target Identifiers dynamically sized by RCS
    this.targets.forEach((tgt) => {
      if (!tgt.detected || tgt.blipAge > 100) return;
      const rad = ((tgt.angle - 90) * Math.PI) / 180;
      const dist = (tgt.range / this.scanRange) * R;
      if (dist > R) return;

      const tx = cx + dist * Math.cos(rad);
      const ty = cy + dist * Math.sin(rad);

      // Base size 4px, growing by 1.5px per 1 m² of RCS
      const size = 4 + tgt.rcs * 1.5;

      ctx.strokeStyle = 'rgba(0, 255, 200, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tx - size / 2, ty - size / 2, size, size);

      ctx.fillStyle = 'rgba(0, 255, 200, 0.8)';
      ctx.font = '9px IBM Plex Mono, monospace';
      ctx.fillText(tgt.label, tx + size / 2 + 4, ty + 3);
    });

    ctx.fillStyle = 'rgba(26,115,232,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PHASED ARRAY MODE', cx, H - 6);
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
    this.drawRadarBg(ctx, cx, cy, R, 'rgba(52,168,83,0.15)');

    const angleRad = ((this.trdAngle - 90) * Math.PI) / 180;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(angleRad), cy + R * Math.sin(angleRad));
    ctx.strokeStyle = 'rgba(52,168,83,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Dynamically draw legacy targets based on RCS
    this.targets.forEach((tgt) => {
      if (!tgt.trdDetected || tgt.trdBlipAge > 100) return;
      const rad = ((tgt.angle - 90) * Math.PI) / 180;
      const dist = (tgt.range / this.scanRange) * R;
      if (dist > R) return;

      const tx = cx + dist * Math.cos(rad);
      const ty = cy + dist * Math.sin(rad);

      const size = 4 + tgt.rcs * 1.5;

      ctx.strokeStyle = 'rgba(52, 168, 83, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tx - size / 2, ty - size / 2, size, size);

      ctx.fillStyle = 'rgba(52, 168, 83, 0.8)';
      ctx.font = '9px IBM Plex Mono, monospace';
      ctx.fillText(tgt.label, tx + size / 2 + 4, ty + 3);
    });

    ctx.fillStyle = 'rgba(52,168,83,0.7)';
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MECHANICAL RADAR', cx, H - 6);
  }

  private drawPatternCanvas(): void {
    const canvas = this.patternCanvasRef?.nativeElement;
    if (!canvas || !this.radarInfo) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = (canvas.width = canvas.offsetWidth || 300);
    const H = (canvas.height = canvas.offsetHeight || 150);
    ctx.clearRect(0, 0, W, H);

    // Draw Background Grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const y = H - (i / 4) * H;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    const pattern = this.radarInfo.beam_pattern_db || this.radarInfo.beam_pattern;
    if (!pattern || pattern.length === 0) return;

    // ABSOLUTE AUTO-SCALING: dynamically map the actual data range
    const maxVal = Math.max(...pattern);
    let minVal = Math.min(...pattern);

    // Fallback guard to prevent division by zero if the array is totally uniform
    if (maxVal === minVal) {
      minVal = maxVal - 1;
    }

    ctx.beginPath();
    ctx.strokeStyle = '#34a853';
    ctx.lineWidth = 2;

    for (let i = 0; i < pattern.length; i++) {
      const x = (i / (pattern.length - 1)) * W;

      // Strictly stretch the value between the canvas floor (H) and ceiling (0)
      const y = H - ((pattern[i] - minVal) / (maxVal - minVal)) * H;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private drawRadarBg(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    lineColor: string, // <--- Changed to correctly catch your 5th argument
  ): void {
    ctx.save();

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;

    // Draw the 4 concentric range rings
    [0.25, 0.5, 0.75, 1].forEach((frac) => {
      ctx.beginPath();
      ctx.arc(cx, cy, R * frac, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Draw the radar crosshairs (spokes)
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();

    ctx.restore();
  }
}
