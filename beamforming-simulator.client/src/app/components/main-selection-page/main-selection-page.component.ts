// ══════════════════════════════════════════════════════════════════
//  MainSelectionPageComponent
//  Top-level shell: top-bar + mode selector + mode viewport
// ══════════════════════════════════════════════════════════════════

import {
  Component, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule }  from '@angular/forms';

import { ModeUltrasoundComponent } from '../modes/mode-ultrasound/mode-ultrasound.component';
import { Mode5gComponent }         from '../modes/mode-5g/mode-5g.component';
import { ModeRadarComponent }      from '../modes/mode-radar/mode-radar.component';
import { BeamBuilderComponent } from '../beam-builder/beam-builder.component';
import { SimMode, PREDEFINED_SCENARIOS, ScenarioPreset } from '../../models/beamforming.models';

interface ModeOption {
  id         : SimMode;
  label      : string;
  icon       : string;
  description: string;
  accent     : string;
}

@Component({
  selector       : 'app-main-selection-page',
  standalone     : true,
  imports        : [
    CommonModule, FormsModule,
    ModeUltrasoundComponent,
    Mode5gComponent,
    ModeRadarComponent,
    BeamBuilderComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl    : './main-selection-page.component.html',
  styleUrls      : ['./main-selection-page.component.css'],
})
export class MainSelectionPageComponent {

  activeMode : SimMode = 'generic-beam-forming';
  sidebarOpen: boolean = false;

  modes: ModeOption[] = [
    {
      id: 'ultrasound',
      label: 'Ultrasound',
      description: 'Phased array probe with real-time wavefront propagation & B-mode imaging',
      accent: '#1a73e8',
      icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M4 16 Q4 4 10 4 Q16 4 16 16" stroke-linecap="round"/>
              <path d="M7 16 Q7 7 10 7 Q13 7 13 16" stroke-linecap="round"/>
              <line x1="4" y1="16" x2="16" y2="16" stroke-linecap="round"/>
            </svg>`,
    },
    {
      id: '5g',
      label: '5G Beamforming',
      description: 'Interactive map with base stations, mobile users, and dynamic beam steering',
      accent: '#34a853',
      icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M3 17c0-4 3-7 7-7s7 3 7 7" stroke-linecap="round"/>
              <path d="M6 14c0-2 2-4 4-4s4 2 4 4" stroke-linecap="round"/>
              <circle cx="10" cy="12" r="1.2" fill="currentColor"/>
              <path d="M10 5V3M7 6l-1.5-1.5M13 6l1.5-1.5" stroke-linecap="round"/>
            </svg>`,
    },
    {
      id: 'radar',
      label: 'Radar',
      description: 'Phased-array beamforming scan vs traditional rotating sweep with target detection',
      accent: '#e8a82b',
      icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="10" cy="10" r="7"/>
              <circle cx="10" cy="10" r="4"/>
              <circle cx="10" cy="10" r="1.5" fill="currentColor"/>
              <line x1="10" y1="10" x2="15" y2="4" stroke-linecap="round"/>
            </svg>`,
    },
    {
      id: 'generic-beam-forming',
      label: 'Beam Builder',
      description: 'Physics sandbox: manually configure elements, phases, and geometry to design custom interference patterns',
      accent: '#a142f4',
      icon: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">
              <rect x="3" y="14" width="3" height="3" rx="0.5" stroke-linecap="round"/>
              <rect x="8.5" y="14" width="3" height="3" rx="0.5" stroke-linecap="round"/>
              <rect x="14" y="14" width="3" height="3" rx="0.5" stroke-linecap="round"/>
              <path d="M4.5 14V7m5.5 7V4m5.5 10v-5" stroke-dasharray="2 2"/>
              <circle cx="4.5" cy="7" r="1.2" fill="currentColor"/>
              <circle cx="10" cy="4" r="1.2" fill="currentColor"/>
              <circle cx="15.5" cy="9" r="1.2" fill="currentColor"/>
            </svg>`,
    },
  ];

  get activeOption(): ModeOption {
    return this.modes.find(m => m.id === this.activeMode)!;
  }

  allScenarios: ScenarioPreset[] = PREDEFINED_SCENARIOS;

  setMode(mode: SimMode): void {
    this.activeMode = mode;
  }
}
