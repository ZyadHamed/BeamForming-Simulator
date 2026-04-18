from dataclasses import dataclass, field
import numpy as np
from scipy.signal import windows
from typing import List, Literal, Optional
import numpy as np
import matplotlib.pyplot as plt
from PIL import Image
import base64
import io

@dataclass
class ComplexArray:
    re: List[float]
    im: List[float]

@dataclass
class BeamformingResult:
    beam_pattern_db: List[float]  # The downsampled beam profile for plotting
    angles_deg: List[float]       # The corresponding angles for the X-axis
    # time_domain: List[float]    # (Keep this only if you plot the raw RF pulse)
    beam_angle: float
    side_lobe_level: float
    main_lobe_width: float


@dataclass
class InterferenceFieldResult:
    image_base64: str
    cols: int
    rows: int


@dataclass
class ProbeElement:
    """Represents a single element in the transducer array."""
    element_id: str
    label: str
    color: str
    frequency: float          # MHz [0.1 – 2000]
    phase_shift: float        # degrees [0 – 360]
    time_delay: float         # µs [0 – 50]
    intensity: float          # % [0 – 100]
    enabled: bool
    apodization_weight: float = 1.0

    def get_phase_radians(self) -> float:
        return np.deg2rad(self.phase_shift)

    def get_angular_frequency(self) -> float:
        # frequency in MHz → omega in rad/µs
        return 2.0 * np.pi * self.frequency

    def generate_element_signal(self, time_vector: np.ndarray) -> np.ndarray:
        if not self.enabled:
            return np.zeros_like(time_vector)
        omega = self.get_angular_frequency()
        phase_rad = self.get_phase_radians()
        amplitude = (self.intensity / 100.0) * self.apodization_weight
        signal = amplitude * np.cos(omega * (time_vector - self.time_delay) + phase_rad)
        signal[time_vector < self.time_delay] = 0.0
        return signal


@dataclass
class ArrayConfig:
    """Manages the overall array geometry, steering, and windowing configurations."""
    elements: List[ProbeElement]
    steering_angle: float     # degrees
    focus_depth: float        # mm
    element_spacing: float    # mm
    geometry: Literal['linear', 'curved', 'phased']
    curvature_radius: float   # mm
    num_elements: int
    snr: float
    apodization_window: Literal['none', 'hanning', 'hamming', 'blackman', 'kaiser', 'tukey']
    kaiser_beta: float = 14.0
    tukey_alpha: float = 0.5
    wave_speed: float = 1.54  # mm/µs (typical soft tissue)

    def apply_apodization(self) -> None:
        active_elements = [el for el in self.elements if el.enabled]
        n_active = len(active_elements)
        if n_active == 0:
            return
        if self.apodization_window == 'none':
            weights = np.ones(n_active)
        elif self.apodization_window == 'hanning':
            weights = np.hanning(n_active)
        elif self.apodization_window == 'hamming':
            weights = np.hamming(n_active)
        elif self.apodization_window == 'blackman':
            weights = np.blackman(n_active)
        elif self.apodization_window == 'kaiser':
            weights = np.kaiser(n_active, self.kaiser_beta)
        elif self.apodization_window == 'tukey':
            weights = windows.tukey(n_active, alpha=self.tukey_alpha)
        else:
            weights = np.ones(n_active)
        for el, weight in zip(active_elements, weights):
            el.apodization_weight = float(weight)

    def _element_x_positions(self) -> np.ndarray:
        """Return x-position (mm) for every element (enabled or not)."""
        n = self.num_elements
        return np.array([(i - (n - 1) / 2.0) * self.element_spacing
                         for i in range(n)])
    
    def _element_positions(self) -> np.ndarray:
        """Returns (N, 2) array of [x, z] positions in mm."""
        n = self.num_elements
        positions = np.zeros((n, 2))
        
        if self.geometry == 'linear':
            for i in range(n):
                positions[i, 0] = (i - (n - 1) / 2.0) * self.element_spacing
                positions[i, 1] = 0.0
        elif self.geometry == 'curved':
            R = self.curvature_radius
            total_angle = (n - 1) * self.element_spacing / R  # arc subtended
            for i in range(n):
                theta = (i - (n - 1) / 2.0) * self.element_spacing / R
                positions[i, 0] = R * np.sin(theta)
                positions[i, 1] = R * (1 - np.cos(theta))  # z offset from apex
        return positions

    def calculate_steering_delays(self) -> None:
        angle_rad = np.deg2rad(self.steering_angle)
        positions = self._element_positions()

        # Focal point at infinity in the steering direction (plane wave)
        steer_vec = np.array([np.sin(angle_rad), np.cos(angle_rad)])

        for i, el in enumerate(self.elements):
            if not el.enabled:
                continue
            # Project element position onto steering direction
            # Elements ahead of centre fire later (positive delay)
            raw_delay = np.dot(positions[i], steer_vec) / self.wave_speed
            el.time_delay = raw_delay

        delays = [el.time_delay for el in self.elements if el.enabled]
        if delays:
            min_delay = min(delays)
            for el in self.elements:
                if el.enabled:
                    el.time_delay -= min_delay

    def calculate_focus_delays(self) -> None:
        """
        Add focusing delays on top of any existing steering delays.
        Elements further from the focal point fire earlier.
        Delays are re-normalised after being combined with steering delays.
        """
        if self.focus_depth <= 0:
            return  # plane wave – no focusing

        x_positions = self._element_x_positions()

        for i, el in enumerate(self.elements):
            if not el.enabled:
                continue
            if self.geometry == 'linear':
                tof = np.sqrt(x_positions[i] ** 2 + self.focus_depth ** 2) / self.wave_speed
                # Subtract TOF so far elements fire earlier
                el.time_delay -= tof

        # Re-normalise so no negative delays
        delays = [el.time_delay for el in self.elements if el.enabled]
        if delays:
            min_delay = min(delays)
            for el in self.elements:
                if el.enabled:
                    el.time_delay -= min_delay

    def compute_beamforming(self,
                                num_samples: int = 1024,
                                sampling_rate_mhz: float = 100.0,
                                calculate_time_domain: bool = True) -> BeamformingResult:
            """
            Highly Optimized Frequency-domain delay-and-sum beamforming.
            Uses NumPy broadcasting to calculate the angular sweep instantly.
            """
            active_els = [el for el in self.elements if el.enabled]
            n_active = len(active_els)

            # --- 1. FFT & TIME DOMAIN (Can be skipped for Radar PPI Scans) ---
            if calculate_time_domain and n_active > 0:
                freqs = np.fft.fftfreq(num_samples, d=1.0 / sampling_rate_mhz)
                omega = 2.0 * np.pi * freqs
                combined_spectrum = np.zeros(num_samples, dtype=complex)

                for el in active_els:
                    f0 = el.frequency
                    sigma = (f0 * 0.6) / 2.355
                    S_f = np.exp(-0.5 * ((np.abs(freqs) - f0) / sigma) ** 2)

                    static_phase = np.sign(freqs) * el.get_phase_radians()
                    phase_ramp = (-omega * el.time_delay) + static_phase
                    amplitude = (el.intensity / 100.0) * el.apodization_weight

                    el_spectrum = amplitude * S_f * np.exp(1j * phase_ramp)
                    combined_spectrum += el_spectrum

                time_domain = np.fft.ifft(combined_spectrum).real.tolist()
            else:
                time_domain = []

            # --- 2. VECTORIZED ANGULAR SWEEP (The Performance Fix) ---
            angles_deg = np.linspace(-90, 90, 3601)
            angles_rad = np.deg2rad(angles_deg)

            if n_active > 0:
                # Extract element data into fast NumPy arrays
                # Shape of these arrays will be (N, 1) to allow broadcasting against angles
                all_positions = self._element_x_positions()
                x_positions = all_positions[[i for i, el in enumerate(self.elements) if el.enabled]]
                freqs_el = np.array([el.frequency for el in active_els])
                amps = np.array([(el.intensity / 100.0) * el.apodization_weight for el in active_els])
                time_delays = np.array([el.time_delay for el in active_els])
                static_phases = np.array([el.get_phase_radians() for el in active_els])

                # Calculate wavenumbers and base phases
                k = 2.0 * np.pi * freqs_el / self.wave_speed
                base_phases = static_phases - (2.0 * np.pi * freqs_el * time_delays)

                # BROADCASTING MAGIC:
                # k[:, None] creates a column vector. angles_rad[None, :] creates a row vector.
                # Multiplying them generates a full 2D matrix (Elements x Angles) instantly in C.
                spatial_phases = k[:, None] * x_positions[:, None] * np.sin(angles_rad)[None, :]
                total_phases = spatial_phases + base_phases[:, None]

                # Calculate complex phasors and sum across the elements (axis=0)
                phasors = amps[:, None] * np.exp(1j * total_phases)
                beam_pattern = np.abs(np.sum(phasors, axis=0))

                # Normalize
                max_val = np.max(beam_pattern)
                if max_val > 0:
                    beam_pattern /= max_val
            else:
                beam_pattern = np.zeros(len(angles_deg))

            # After normalising beam_pattern, before converting to dB:
            noise_std = 10 ** (-self.snr / 20)   # convert dB → linear amplitude
            noise = np.random.normal(0, noise_std, size=beam_pattern.shape)
            beam_pattern = np.clip(beam_pattern + noise, 0, None)
            # Then re-normalise
            beam_pattern /= np.max(beam_pattern)

            beam_pattern_db = 20.0 * np.log10(np.clip(beam_pattern, 1e-12, None))

            # --- 3. ROBUST MAIN-LOBE ISOLATION ---
            peak_idx = int(np.argmax(beam_pattern_db))
            
            left_idx = peak_idx
            while left_idx > 0 and beam_pattern_db[left_idx - 1] >= -3.0:
                left_idx -= 1

            right_idx = peak_idx
            while right_idx < len(beam_pattern_db) - 1 and beam_pattern_db[right_idx + 1] >= -3.0:
                right_idx += 1

            main_lobe_width = float(angles_deg[right_idx] - angles_deg[left_idx])

            side_lobe_mask = np.ones(len(beam_pattern_db), dtype=bool)
            side_lobe_mask[left_idx:right_idx + 1] = False

            side_lobe_level = float(np.max(beam_pattern_db[side_lobe_mask])) if np.any(side_lobe_mask) else -1000

            # --- 4. FRONTEND DOWN-SAMPLING ---
            # Reduce 3601 points to ~180 points for fast JSON transmission
            downsample_factor = 20 

            return BeamformingResult(
                beam_pattern_db=beam_pattern_db[::downsample_factor].tolist(),
                angles_deg=angles_deg[::downsample_factor].tolist(),
                beam_angle=self.steering_angle,
                side_lobe_level=side_lobe_level,
                main_lobe_width=main_lobe_width
            )

    def compute_interference_field(self,
                                    width_mm: float,
                                    depth_mm: float,
                                    resolution_mm: float) -> InterferenceFieldResult:
            """
            Fully vectorized CW interference pattern using 3D broadcasting.
            Calculates all elements across the entire grid in one pass.
            """
            # 1. Setup spatial grid (2D)
            x = np.arange(-width_mm / 2.0, width_mm / 2.0, resolution_mm)
            z = np.arange(0, depth_mm, resolution_mm)
            xx, zz = np.meshgrid(x, z)
            rows, cols = xx.shape

            # 2. Extract active element data into arrays (1D)
            active_indices = [i for i, el in enumerate(self.elements) if el.enabled]
            if not active_indices:
                return self._empty_interference_result(cols, rows)

            active_els = [self.elements[i] for i in active_indices]
            x_positions = self._element_x_positions()[active_indices]
            
            # Pre-calculate element-specific constants
            freqs = np.array([el.frequency for el in active_els])
            omegas = 2.0 * np.pi * freqs
            ks = omegas / self.wave_speed
            phases = np.array([el.get_phase_radians() for el in active_els])
            delays = np.array([el.time_delay for el in active_els])
            total_phases = phases - (omegas * delays)
            amplitudes = np.array([(el.intensity / 100.0) * el.apodization_weight for el in active_els])

            # 3. Reshape for 3D Broadcasting
            # Grid: (rows, cols, 1) | Elements: (1, 1, num_elements)
            xx_3d = xx[:, :, np.newaxis]
            zz_3d = zz[:, :, np.newaxis]
            
            x_pos_3d = x_positions[np.newaxis, np.newaxis, :]
            k_3d = ks[np.newaxis, np.newaxis, :]
            phase_3d = total_phases[np.newaxis, np.newaxis, :]
            amp_3d = amplitudes[np.newaxis, np.newaxis, :]

            # 4. Core Computation (The "Magic" Step)
            # Distance 'r' is now a (rows, cols, num_elements) matrix
            r = np.sqrt((xx_3d - x_pos_3d)**2 + zz_3d**2) + 1e-9
            
            # Calculate the complex wave field for all elements simultaneously
            # P = (A / sqrt(r)) * exp(j * (-k*r + phase))
            pressure_field_3d = (amp_3d / np.sqrt(r)) * np.exp(1j * (-k_3d * r + phase_3d))

            # Sum across the element axis (axis 2) to get the final 2D interference pattern
            pressure_field = np.sum(pressure_field_3d, axis=2)

            # 5. Post-processing (Magnitude, Normalization, Base64)
            magnitude = np.abs(pressure_field)
            max_val = np.max(magnitude)
            if max_val > 0:
                magnitude /= max_val
            noise_std = 10 ** (-self.snr / 20)
            noise = np.random.normal(0, noise_std, size=magnitude.shape)
            magnitude = np.clip(magnitude + noise, 0, None)
            magnitude /= np.max(magnitude)
            
            pixel_data = np.uint8(magnitude * 255)
            img = Image.fromarray(pixel_data, mode='L')
            
            buffer = io.BytesIO()
            img.save(buffer, format="PNG")
            b64_string = base64.b64encode(buffer.getvalue()).decode('utf-8')
            
            return InterferenceFieldResult(
                image_base64=f"data:image/png;base64,{b64_string}",
                cols=cols,
                rows=rows
            )

