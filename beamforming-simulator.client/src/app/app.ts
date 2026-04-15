import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MainSelectionPageComponent } from './components/main-selection-page/main-selection-page.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MainSelectionPageComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('beamforming-simulator.client');
}
