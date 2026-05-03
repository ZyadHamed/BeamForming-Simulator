import math
import base64
import io
from dataclasses import dataclass
from typing import List, Optional

import numpy as np
from PIL import Image

from Objects.ArrayConfig import ArrayConfig, BeamformingResult, InterferenceFieldResult
from Objects.Physics.RadarEnviroment import RadarEnvironment
from Objects.Scenarios.Scenario import Scenario

# ── Physical constants ─────────────────────────────────────────────────────────
_C          =  299_792_458.0  #300_000.0                                    # speed of light, m/s
_4PI3_DB    = 10.0 * math.log10((4.0 * math.pi) ** 3)  # ≈ 33.0 dB
_EFF_DB     = -1.5                                     # aperture efficiency (empirical)


@dataclass(frozen=True)
class RadarWaveform:
    pt_dbm:         float = 70.0    # peak transmit power, dBm
    prf_hz:         float = 1000.0  # pulse repetition frequency, Hz
    pulse_width_us: float = 1.0     # pulse width, microseconds

    @property
    def max_unambiguous_range_m(self) -> float:
        """R_ua = c / (2 · PRF)"""
        return _C / (2.0 * self.prf_hz)

    @property
    def range_resolution_m(self) -> float:
        """δR = c · τ / 2"""
        return (_C * self.pulse_width_us * 1e-6) / 2.0



@dataclass(frozen=True)
class RadarDetectionConfig:
    guard_cells: int   = 2
    ref_cells:   int   = 8
    pfa:         float = 1e-4


@dataclass
class RadarDetection:
    target_id:          str
    range_m:            float
    angle_deg:          float
    snr_db:             float
    estimated_rcs:      float
    estimated_extent_m: float = 0.0   # cross-range size estimate (metres); 0 = unknown


@dataclass
class RadarScanResult:
    timestamp:  float
    detections: List[RadarDetection]
    sweep_data: List[dict]


def compute_cfar_threshold(power_bins: np.ndarray, cfg: RadarDetectionConfig) -> np.ndarray:
    """Compute the CA-CFAR detection threshold for every range bin."""
    n       = len(power_bins)
    n_ref   = 2 * cfg.ref_cells
    if n_ref == 0:
        return np.full(n, np.inf)

    alpha     = n_ref * (cfg.pfa ** (-1.0 / n_ref) - 1.0)
    half_w    = cfg.guard_cells + cfg.ref_cells
    thresholds = np.full(n, np.nan)

    for k in range(n):
        left  = power_bins[max(0, k - half_w) : max(0, k - cfg.guard_cells)]
        right = power_bins[min(n, k + cfg.guard_cells + 1) : min(n, k + half_w + 1)]
        ref   = np.concatenate([left, right])
        if len(ref) > 0:
            thresholds[k] = alpha * float(np.mean(ref))

    # Fill leading / trailing NaNs by propagation
    valid = ~np.isnan(thresholds)
    if valid.any():
        idx = np.where(valid, np.arange(n), 0)
        np.maximum.accumulate(idx, out=idx)
        thresholds = thresholds[idx]
        idx2 = np.where(valid, np.arange(n), n - 1)
        idx2 = idx2[::-1]
        np.minimum.accumulate(idx2, out=idx2)
        thresholds = np.minimum(thresholds, thresholds[idx2[::-1]])

    nan_mask = np.isnan(thresholds)
    if nan_mask.any():
        valid_vals = thresholds[~nan_mask]
        fill = (
            float(np.min(valid_vals)) if valid_vals.size > 0
            else alpha * float(np.mean(power_bins[~nan_mask]) if (~nan_mask).any() else 1.0)
        )
        thresholds[nan_mask] = fill

    return thresholds


class RadarScenario(Scenario):
    """Phased-array radar PPI scan engine with a physically correct signal model."""

    def __init__(
        self,
        config:        ArrayConfig,
        environment:   RadarEnvironment,
        waveform:      Optional[RadarWaveform]        = None,
        detection_cfg: Optional[RadarDetectionConfig] = None,
    ) -> None:
        super().__init__(config, environment)
        self._waveform      : RadarWaveform        = waveform      or RadarWaveform()
        self._detection_cfg : RadarDetectionConfig = detection_cfg or RadarDetectionConfig()
        # ArrayConfig uses mm/µs internally; radar needs m/s converted.
        self.config.wave_speed = _C * 1e-3   # 299 792.458 mm/µs

    @property
    def waveform(self) -> RadarWaveform:
        return self._waveform

    @property
    def detection_cfg(self) -> RadarDetectionConfig:
        return self._detection_cfg

    @property
    def carrier_freq_hz(self) -> float:
        enabled = [el for el in self.config.elements if el.enabled]
        return (enabled[0].frequency if enabled else 9_500.0) * 1e6 # MHz → Hz

    @property
    def wavelength_m(self) -> float:
        """λ = c / f"""
        return _C / self.carrier_freq_hz

    @property
    def array_gain_db(self) -> float:
        # One-way peak gain: G = π·N·η for a linear array at λ/2 spacing
        n = max(sum(1 for el in self.config.elements if el.enabled), 1)
        return 10.0 * math.log10(math.pi * n) + _EFF_DB

    @property
    def hpbw_deg(self) -> float:
        n    = max(sum(1 for el in self.config.elements if el.enabled), 1)
        d_m  = self.config.element_spacing / 1_000.0   # mm → m
        apert = max((n - 1) * d_m, d_m)
        return min(90.0, math.degrees(0.886 * self.wavelength_m / apert))

    def update_config(self, new_config: ArrayConfig) -> None:
        super().update_config(new_config)
        self.config.wave_speed = _C * 1e-3

    def get_scan_parameters(self) -> dict:
        return {
            "carrier_freq_hz":         self.carrier_freq_hz,
            "wavelength_m":            self.wavelength_m,
            "array_gain_db":           self.array_gain_db,
            "hpbw_deg":                self.hpbw_deg,
            "range_resolution_m":      self._waveform.range_resolution_m,
            "max_unambiguous_range_m": self._waveform.max_unambiguous_range_m,
            "pt_dbm":                  self._waveform.pt_dbm,
            "prf_hz":                  self._waveform.prf_hz,
            "pulse_width_us":          self._waveform.pulse_width_us,
            "noise_floor_dbm":         self.environment.noise_floor_dbm,
        }
    
    def _run_dwell(
    self,
        steer_angle_global: float,
        ranges_m:           np.ndarray,
        max_range_m:        float,
        pt_dbm:             float,
        g0_db:              float,
        lam_db:             float,
        scan_front_only:    bool = False,
        scan_back_only:     bool = False,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Execute one dwell: steer the array, compute received power per range bin.

        Returns
        -------
        power_bins : np.ndarray  – linear SNR accumulated per range bin
        bp_db      : np.ndarray  – beam pattern gain (dB) vs angle
        bp_ang     : np.ndarray  – angles corresponding to bp_db (degrees)

        The caller is responsible for CFAR thresholding, detection matching,
        RCS inversion, and sweep-line emission.
        """
        num_range_bins = len(ranges_m)

        self.config.steering_angle = steer_angle_global
        self.config.calculate_steering_delays()

        beam_result = self.config.compute_beamforming(
            num_samples           = 128,
            calculate_time_domain = False,
        )
        bp_db  = np.asarray(beam_result.beam_pattern_db)
        bp_ang = np.asarray(beam_result.angles_deg)

        power_bins = np.zeros(num_range_bins, dtype=float)

        mirror_angle = (180.0 - steer_angle_global) % 360.0

        for target in self.environment.targets:
            r       = target.range_m
            bearing = target.bearing_deg

            if r > max_range_m or r < 1.0:
                continue

             # Angular offset from the front lobe and from the back lobe
            rel_front  = (bearing - steer_angle_global + 180.0) % 360.0 - 180.0
            rel_mirror = (bearing - mirror_angle       + 180.0) % 360.0 - 180.0

            target_in_front = abs(rel_front) <= abs(rel_mirror)

            # Sequential scanning: skip targets on the wrong side
            if scan_front_only and not target_in_front:
                continue
            if scan_back_only and target_in_front:
                continue

            rel_ang = rel_front if target_in_front else rel_mirror
            rel_ang = max(-90.0, min(90.0, rel_ang))

            relative_gain_db = float(np.interp(rel_ang, bp_ang, bp_db))
            one_way_gain_db  = g0_db + relative_gain_db

            pr_dbm = (
                pt_dbm
                + 2.0 * one_way_gain_db
                + 2.0 * lam_db
                + target.rcs_db
                - _4PI3_DB
                - 40.0 * math.log10(max(r, 1.0))
            )

            snr_db     = pr_dbm - self.environment.noise_plus_clutter_dbm(r)
            snr_linear = 10.0 ** (snr_db / 10.0)

            bin_idx = int(np.argmin(np.abs(ranges_m - r)))
            power_bins[bin_idx] += snr_linear

        # Add receiver noise once per dwell — not per target
        if self.config.snr < 1000.0:
            noise_std = 10 ** (-self.config.snr / 20.0)
            power_bins = np.clip(
                power_bins + np.random.normal(
                    0, noise_std * float(np.max(power_bins) + 1e-30), power_bins.shape
                ), 0, None,
            )

        return power_bins, bp_db, bp_ang

    def compute_interference_field(
        self,
        width_mm:      float = 500.0,
        depth_mm:      float = 500.0,
        resolution_mm: float = 2.0,
        steering_angle: float | None = None,
    ) -> "InterferenceFieldResult":
        """
        CW interference pattern of the phased array on a 2-D spatial grid.
        Uses coherent complex superposition; magnitude is then log-compressed.
        """
        if steering_angle is not None:
            self.config.steering_angle = steering_angle
            self.config.calculate_steering_delays()
            
        # ── 1. Global spatial grid (shared by all faces) ──────────────────
        half = max(width_mm, depth_mm) / 2.0
        x = np.arange(-half, half, max(resolution_mm, 1.0))
        z = np.arange(-half, half, max(resolution_mm, 1.0))
        xx, zz = np.meshgrid(x, z)          # (rows, cols)
        rows, cols = xx.shape

        active_indices = [i for i, el in enumerate(self.config.elements) if el.enabled]
        if not active_indices:
            empty = np.zeros((rows, cols), dtype=np.uint8)
            img   = Image.fromarray(empty, mode='L')
            buf   = io.BytesIO(); img.save(buf, format='PNG')
            b64   = base64.b64encode(buf.getvalue()).decode('utf-8')
            return InterferenceFieldResult(
                image_base64=f"data:image/png;base64,{b64}",
                cols=cols, rows=rows,
            )

        active_els  = [self.config.elements[i] for i in active_indices]
        x_base      = self.config._element_x_positions()[active_indices]
        z_base      = np.zeros_like(x_base)

        freqs       = np.array([el.frequency           for el in active_els])
        omegas      = 2.0 * np.pi * freqs
        ks          = omegas / self.config.wave_speed
        phases      = np.array([el.get_phase_radians() for el in active_els])
        delays      = np.array([el.time_delay          for el in active_els])
        total_phases= phases - (omegas * delays)
        amplitudes  = np.array(
            [(el.intensity / 100.0) * el.apodization_weight for el in active_els]
        )

        # ── 2. Single-face complex field (boresight = North / 0°) ────────
        xx_3d = xx[:, :, np.newaxis]
        zz_3d = zz[:, :, np.newaxis]
        xi_3d = x_base[np.newaxis, np.newaxis, :]
        zi_3d = z_base[np.newaxis, np.newaxis, :]
        k_3d  = ks          [np.newaxis, np.newaxis, :]
        phi_3d= total_phases[np.newaxis, np.newaxis, :]
        amp_3d= amplitudes  [np.newaxis, np.newaxis, :]

        r_field = np.sqrt((xx_3d - xi_3d) ** 2 + (zz_3d - zi_3d) ** 2) + 1e-9
        total_complex = np.sum(
            (amp_3d / np.sqrt(r_field)) * np.exp(1j * (-k_3d * r_field + phi_3d)),
            axis=2,
        )
        
        # ── 3. Post-processing ────────────────────────────────────────────
        magnitude = np.abs(total_complex)
        max_val   = np.max(magnitude)
        if max_val > 0:
            magnitude /= max_val

        noise_std = 10 ** (-self.config.snr / 20)
        magnitude = np.clip(
            magnitude + np.random.normal(0, noise_std, magnitude.shape), 0, None
        )
        magnitude /= np.max(magnitude)

        pixel_data = np.uint8(magnitude * 255)
        img = Image.fromarray(pixel_data, mode='L')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        b64 = base64.b64encode(buf.getvalue()).decode('utf-8')

        return InterferenceFieldResult(
            image_base64=f"data:image/png;base64,{b64}",
            cols=cols,
            rows=rows,
        )

    def perform_default_scan(
        self,
        max_range_m:    float = 150_000.0,
        num_lines:      int   = 360,
        num_range_bins: int   = 128,
    ) -> RadarScanResult:
        return self.generate_ppi_scan(
            num_lines      = num_lines,
            max_range_m    = max_range_m,
            num_range_bins = num_range_bins,
        )

    def generate_traditional_scan(
        self,
        start_angle:    float,
        end_angle:      float,
        num_lines:      int,
        max_range_m:    float,
        num_range_bins: int = 128,
    ) -> RadarScanResult:
        """
        Simulates a mechanically rotating radar.

        Scanning mechanism: the antenna physically points at each sweep angle
        (no electronic steering, no beamforming). Gain applied via sinc²
        one-way pattern centred on the physical boresight.

        Satisfies spec §2B: "Fixed sinc² beamform. No beamforming."
        """
        angles_deg  = np.linspace(start_angle, end_angle, max(num_lines, 1))
        ranges_m    = np.linspace(
            self._waveform.range_resolution_m,
            max_range_m,
            num_range_bins,
        )
        bin_width_m = float(ranges_m[1] - ranges_m[0]) if num_range_bins > 1 else max_range_m

        sweep_data : List[dict]           = []
        detections : List[RadarDetection] = []

        lam_db   = 20.0 * math.log10(self.wavelength_m)
        g0_db    = self.array_gain_db
        pt_dbm   = self._waveform.pt_dbm
        hpbw_rad = math.radians(self.hpbw_deg)

        target_track: dict = {}

        for antenna_angle in angles_deg:
            power_bins  = np.zeros(num_range_bins, dtype=float)
            _target_meta: dict = {}

            for target in self.environment.targets:
                r       = target.range_m
                bearing = target.bearing_deg

                if r > max_range_m or r < 1.0:
                    continue

                # Angular offset from physical boresight (no steering offset)
                rel_ang_deg = (bearing - float(antenna_angle) + 180.0) % 360.0 - 180.0
                rel_ang_rad = math.radians(rel_ang_deg)

                # sinc² one-way gain — no beamforming, fixed beam shape
                # x is normalised so the argument to sinc hits ±π at the first
                # null of the sinc pattern (at ±HPBW from boresight).
                x = math.pi * rel_ang_rad / hpbw_rad
                sinc_val = math.sin(x) / x if abs(x) > 1e-9 else 1.0
                one_way_gain_db = g0_db + 20.0 * math.log10(abs(sinc_val) + 1e-12)

                pr_dbm = (
                    pt_dbm
                    + 2.0 * one_way_gain_db
                    + 2.0 * lam_db
                    + target.rcs_db
                    - _4PI3_DB
                    - 40.0 * math.log10(max(r, 1.0))
                )

                snr_db     = pr_dbm - self.environment.noise_plus_clutter_dbm(r)
                snr_linear = 10.0 ** (snr_db / 10.0)

                bin_idx = int(np.argmin(np.abs(ranges_m - r)))
                power_bins[bin_idx] += snr_linear
                _target_meta[target.target_id] = (pr_dbm, one_way_gain_db)
            
            # Receiver noise
            if self.config.snr < 1000.0:
                noise_std = 10 ** (-self.config.snr / 20.0)
                power_bins = np.clip(
                    power_bins + np.random.normal(
                        0, noise_std * float(np.max(power_bins) + 1e-30), power_bins.shape
                    ),
                    0, None,
                )

            cfar_thr = compute_cfar_threshold(power_bins, self._detection_cfg)

            for bin_idx in range(num_range_bins):
                if power_bins[bin_idx] <= cfar_thr[bin_idx]:
                    continue

                bin_range  = float(ranges_m[bin_idx])
                snr_db_bin = 10.0 * math.log10(max(power_bins[bin_idx], 1e-30))

                for target in self.environment.targets:
                    if abs(target.range_m - bin_range) > bin_width_m:
                        continue

                    ang_sep = abs((target.bearing_deg - float(antenna_angle) + 180) % 360 - 180)
                    if ang_sep > self.hpbw_deg / 2.0:
                        continue

                    estimated_range_m = float(ranges_m[bin_idx])

                    # RCS inversion
                    pr_dbm_t, g1w_db = _target_meta.get(target.target_id, (pt_dbm, g0_db))
                    noise_dbm   = self.environment.noise_plus_clutter_dbm(estimated_range_m)
                    noise_lin_w = 10.0 ** ((noise_dbm - 30.0) / 10.0)
                    pr_lin      = power_bins[bin_idx] * noise_lin_w
                    pt_lin      = 10.0 ** ((pt_dbm - 30.0) / 10.0)
                    g_lin       = 10.0 ** (g1w_db / 10.0)
                    r4          = max(estimated_range_m, 1.0) ** 4
                    estimated_rcs = max(
                        pr_lin * (4.0 * math.pi) ** 3 * r4
                        / (pt_lin * g_lin ** 2 * self.wavelength_m ** 2),
                        1e-6,
                    )

                    # Update angular subtense tracker
                    a = float(antenna_angle)
                    if target.target_id not in target_track:
                        target_track[target.target_id] = {
                            'first': a, 'last': a,
                            'range': estimated_range_m,
                            'snr':   snr_db_bin,
                            'rcs':   estimated_rcs,
                        }
                    else:
                        entry = target_track[target.target_id]
                        entry['first'] = min(entry['first'], a)
                        entry['last']  = max(entry['last'],  a)
                        if snr_db_bin > entry['snr']:
                            entry['snr']   = snr_db_bin
                            entry['range'] = estimated_range_m
                            entry['rcs']   = estimated_rcs

            compressed = self._log_compress(power_bins)
            sweep_data.append({
                "angle_deg":  float(antenna_angle),
                "range_bins": self._downsample_bins(compressed).tolist(),
            })
        
        # ── Convert angular subtense → physical size ───────────────────────────
        for tid, entry in target_track.items():
            delta_theta_deg  = entry['last'] - entry['first']
            target_theta_deg = max(0.0, delta_theta_deg - self.hpbw_deg)
            target_theta_rad = math.radians(target_theta_deg)
            R                = max(entry['range'], 1.0)
            extent_m         = 2.0 * R * math.tan(target_theta_rad / 2.0)

            detections.append(RadarDetection(
                target_id          = tid,
                range_m            = round(entry['range'], 1),
                angle_deg          = round((entry['first'] + entry['last']) / 2.0, 1),
                snr_db             = round(entry['snr'], 1),
                estimated_rcs      = round(entry['rcs'], 4),
                estimated_extent_m = round(extent_m, 2),
            ))

        return RadarScanResult(
            timestamp  = 0.0,
            detections = detections,
            sweep_data = sweep_data,
        )

    def generate_ppi_scan(
        self,
        num_lines:      int,
        max_range_m:    float,
        num_range_bins: int = 128,
    ) -> RadarScanResult:
        """
        Single phased-array PPI scan exploiting front-back ambiguity.

        A linear array steered to angle θ (measured from boresight = North)
        produces a main lobe at θ AND a mirrored response at (180° − θ) due
        to the isotropic element pattern.  Sweeping θ from 0° to 180° therefore
        illuminates the full 360°:
            steer θ  → detects targets near θ  (front lobe)
            steer θ  → detects targets near 180°−θ (back lobe, same dwell)

        No threading, no face offsets.  One array, one sweep, full coverage.
        """
        ranges_m    = np.linspace(
            self._waveform.range_resolution_m,
            max_range_m,
            num_range_bins,
        )
        bin_width_m = float(ranges_m[1] - ranges_m[0]) if num_range_bins > 1 else max_range_m

        lam_db = 20.0 * math.log10(self.wavelength_m)
        g0_db  = self.array_gain_db
        pt_dbm = self._waveform.pt_dbm

        # Steer from 0° to 180° — covers the full 360° via front/back symmetry
        steer_angles = np.linspace(0.0, 180.0, max(num_lines // 2, 1), endpoint=False)

        sweep_data : List[dict]           = []
        best_det   : dict                 = {}   # target_id → best-SNR RadarDetection

        # ── Pass 1: scan the front half-space ─────────────────────────────────
        for steer_angle in steer_angles:
            mirror_angle = (180.0 - steer_angle) % 360.0

            power_bins, bp_db, bp_ang = self._run_dwell(
                steer_angle_global = steer_angle,
                ranges_m    = ranges_m,
                max_range_m = max_range_m,
                pt_dbm      = pt_dbm,
                g0_db       = g0_db,
                lam_db      = lam_db,
                scan_front_only = True,
            )

            cfar_thr = compute_cfar_threshold(power_bins, self._detection_cfg)

            for bin_idx in range(num_range_bins):
                if power_bins[bin_idx] <= cfar_thr[bin_idx]:
                    continue

                bin_range  = float(ranges_m[bin_idx])
                snr_db_bin = 10.0 * math.log10(max(power_bins[bin_idx], 1e-30))

                for target in self.environment.targets:
                    if abs(target.range_m - bin_range) > bin_width_m:
                        continue

                    rel_front = (target.bearing_deg - steer_angle + 180.0) % 360.0 - 180.0
                    if abs(rel_front) > self.hpbw_deg / 2.0:
                        continue

                    estimated_range_m = float(ranges_m[bin_idx])
                    noise_dbm   = self.environment.noise_plus_clutter_dbm(estimated_range_m)
                    noise_lin_w = 10.0 ** ((noise_dbm - 30.0) / 10.0)
                    pr_lin      = power_bins[bin_idx] * noise_lin_w
                    pt_lin      = 10.0 ** ((pt_dbm - 30.0) / 10.0)
                    one_way_gain_db = g0_db + float(np.interp(
                        max(-90.0, min(90.0, rel_front)), bp_ang, bp_db
                    ))
                    g_lin = 10.0 ** (one_way_gain_db / 10.0)
                    r4    = max(estimated_range_m, 1.0) ** 4
                    estimated_rcs = max(
                        pr_lin * (4.0 * math.pi) ** 3 * r4
                        / (pt_lin * g_lin ** 2 * self.wavelength_m ** 2),
                        1e-6,
                    )

                    det = RadarDetection(
                        target_id     = target.target_id,
                        range_m       = round(estimated_range_m, 1),
                        angle_deg     = round(float(steer_angle), 1),
                        snr_db        = round(snr_db_bin, 1),
                        estimated_rcs = round(estimated_rcs, 4),
                    )
                    existing = best_det.get(target.target_id)
                    if existing is None or det.snr_db > existing.snr_db:
                        best_det[target.target_id] = det

            compressed = self._log_compress(power_bins)
            sweep_data.append({"angle_deg": float(steer_angle), "range_bins": self._downsample_bins(compressed).tolist()})

        # ── Pass 2: scan the back half-space using the mirror lobe ────────────
        for steer_angle in steer_angles:
            mirror_angle = (180.0 - steer_angle) % 360.0

            power_bins, bp_db, bp_ang = self._run_dwell(
                steer_angle_global = steer_angle,
                ranges_m    = ranges_m,
                max_range_m = max_range_m,
                pt_dbm      = pt_dbm,
                g0_db       = g0_db,
                lam_db      = lam_db,
                scan_back_only = True,
            )

            cfar_thr = compute_cfar_threshold(power_bins, self._detection_cfg)

            for bin_idx in range(num_range_bins):
                if power_bins[bin_idx] <= cfar_thr[bin_idx]:
                    continue

                bin_range  = float(ranges_m[bin_idx])
                snr_db_bin = 10.0 * math.log10(max(power_bins[bin_idx], 1e-30))

                for target in self.environment.targets:
                    if abs(target.range_m - bin_range) > bin_width_m:
                        continue

                    rel_mirror = (target.bearing_deg - mirror_angle + 180.0) % 360.0 - 180.0
                    if abs(rel_mirror) > self.hpbw_deg / 2.0:
                        continue

                    estimated_range_m = float(ranges_m[bin_idx])
                    noise_dbm   = self.environment.noise_plus_clutter_dbm(estimated_range_m)
                    noise_lin_w = 10.0 ** ((noise_dbm - 30.0) / 10.0)
                    pr_lin      = power_bins[bin_idx] * noise_lin_w
                    pt_lin      = 10.0 ** ((pt_dbm - 30.0) / 10.0)
                    one_way_gain_db = g0_db + float(np.interp(
                        max(-90.0, min(90.0, rel_mirror)), bp_ang, bp_db
                    ))
                    g_lin = 10.0 ** (one_way_gain_db / 10.0)
                    r4    = max(estimated_range_m, 1.0) ** 4
                    estimated_rcs = max(
                        pr_lin * (4.0 * math.pi) ** 3 * r4
                        / (pt_lin * g_lin ** 2 * self.wavelength_m ** 2),
                        1e-6,
                    )

                    det = RadarDetection(
                        target_id     = target.target_id,
                        range_m       = round(estimated_range_m, 1),
                        angle_deg     = round((mirror_angle + 180.0) % 360.0, 1),
                        snr_db        = round(snr_db_bin, 1),
                        estimated_rcs = round(estimated_rcs, 4),
                    )
                    existing = best_det.get(target.target_id)
                    if existing is None or det.snr_db > existing.snr_db:
                        best_det[target.target_id] = det

            compressed = self._log_compress(power_bins)
            back_angle = (mirror_angle + 180.0) % 360.0
            sweep_data.append({"angle_deg": float(back_angle), "range_bins": self._downsample_bins(compressed).tolist()})

        return RadarScanResult(
            timestamp  = 0.0,
            detections = list(best_det.values()),
            sweep_data = sweep_data,
        )

    def scan_focused(
        self,
        target_angle:   float,
        max_range_m:    float = 150_000.0,
        num_range_bins: int   = 128,
    ) -> RadarScanResult:
        """
        AESA Search-and-Track focused sweep.

        Scans a tight ±2° sector around `target_angle` at 0.5° steps using
        maximum aperture (all elements, no apodization). Deliberately avoids
        the 4-face ThreadPoolExecutor used by generate_ppi_scan — this method
        is always called from an executor thread itself, so nesting thread
        pools would deadlock the default pool under load.
        """
        original_enabled      = [el.enabled            for el in self.config.elements]
        original_apod         = self.config.apodization_window
        original_apod_weights = [el.apodization_weight  for el in self.config.elements]
        original_steering     = self.config.steering_angle

        try:
            # ── Maximum aperture + Hamming window for minimum beam width ──────
            for el in self.config.elements:
                el.enabled = True
            self.config.apodization_window = 'hamming'
            self.config.apply_apodization()

            # Recompute HPBW after switching to full aperture + hamming
            n_active = sum(1 for el in self.config.elements if el.enabled)
            d_m = self.config.element_spacing / 1_000.0
            aperture_m = max((n_active - 1) * d_m, d_m)
            hpbw_focused = min(90.0, math.degrees(0.886 * self.wavelength_m / aperture_m))

            # Fine angular sweep: ±2° at 0.1° steps for accurate subtense measurement
            start_angle = target_angle - 2.0
            end_angle   = target_angle + 2.0
            angles_deg  = np.arange(start_angle, end_angle + 0.1, 0.1)

            ranges_m    = np.linspace(
                self._waveform.range_resolution_m,
                max_range_m,
                num_range_bins,
            )
            bin_width_m = float(ranges_m[1] - ranges_m[0]) if num_range_bins > 1 else max_range_m

            lam_db = 20.0 * math.log10(self.wavelength_m)
            g0_db  = self.array_gain_db
            pt_dbm = self._waveform.pt_dbm

            sweep_data : List[dict]           = []
            detections : List[RadarDetection] = []

            # Per-target tracking for angular subtense
            # Maps target_id → (first_detect_angle, last_detect_angle, best_range, best_snr)
            target_track: dict = {}

            for steer_angle in angles_deg:
                global_steer = float(steer_angle) % 360.0
                power_bins, bp_db, bp_ang = self._run_dwell(
                    steer_angle_global = global_steer,
                    ranges_m    = ranges_m,
                    max_range_m = max_range_m,
                    pt_dbm      = pt_dbm,
                    g0_db       = g0_db,
                    lam_db      = lam_db,
                )

                cfar_thr = compute_cfar_threshold(power_bins, self._detection_cfg)

                for bin_idx in range(num_range_bins):
                    if power_bins[bin_idx] <= cfar_thr[bin_idx]:
                        continue

                    bin_range  = float(ranges_m[bin_idx])
                    snr_db_bin = 10.0 * math.log10(max(power_bins[bin_idx], 1e-30))

                    for target in self.environment.targets:
                        if abs(target.range_m - bin_range) > bin_width_m:
                            continue

                        ang_sep = abs((target.bearing_deg - global_steer + 180) % 360 - 180)
                        if ang_sep > hpbw_focused / 2.0:
                            continue

                        estimated_range_m = float(ranges_m[bin_idx])

                        # ── RCS estimation (same radar equation inversion as PPI) ──
                        noise_dbm   = self.environment.noise_plus_clutter_dbm(estimated_range_m)
                        noise_lin_w = 10.0 ** ((noise_dbm - 30.0) / 10.0)
                        pr_lin      = power_bins[bin_idx] * noise_lin_w
                        pt_lin      = 10.0 ** ((pt_dbm - 30.0) / 10.0)
                        one_way_gain_db = g0_db + float(np.interp(
                            max(-90.0, min(90.0, ang_sep)), bp_ang, bp_db
                        ))
                        g_lin = 10.0 ** (one_way_gain_db / 10.0)
                        r4    = max(estimated_range_m, 1.0) ** 4
                        estimated_rcs = max(
                            pr_lin * (4.0 * math.pi) ** 3 * r4
                            / (pt_lin * g_lin ** 2 * self.wavelength_m ** 2),
                            1e-6,
                        )

                        # ── Update angular subtense tracker ───────────────────────
                        if target.target_id not in target_track:
                            target_track[target.target_id] = {
                                'first': global_steer,
                                'last':  global_steer,
                                'range': estimated_range_m,
                                'snr':   snr_db_bin,
                                'rcs':   estimated_rcs,
                            }
                        else:
                            entry = target_track[target.target_id]
                            entry['first'] = min(entry['first'], global_steer)
                            entry['last']  = max(entry['last'],  global_steer)
                            if snr_db_bin > entry['snr']:
                                entry['snr']   = snr_db_bin
                                entry['range'] = estimated_range_m
                                entry['rcs']   = estimated_rcs

                compressed = self._log_compress(power_bins)
                sweep_data.append({
                    "angle_deg":  global_steer,
                    "range_bins": self._downsample_bins(compressed).tolist(),
                })

            for tid, entry in target_track.items():
                delta_theta_deg = entry['last'] - entry['first']
                # Subtract one HPBW to deconvolve beam smearing.
                # A point target illuminated by a beam of width W
                # appears to span W degrees; a target of physical
                # width s appears to span W + s/R radians.
                target_theta_deg = max(0.0, delta_theta_deg - hpbw_focused)
                target_theta_rad = math.radians(target_theta_deg)
                R = max(entry['range'], 1.0)
                extent_m = R * target_theta_rad   # small-angle: arc = R·θ

                detections.append(RadarDetection(
                    target_id          = tid,
                    range_m            = round(entry['range'], 1),
                    angle_deg          = round(target_angle, 1),
                    snr_db             = round(entry['snr'], 1),
                    estimated_rcs      = round(entry['rcs'], 4),
                    estimated_extent_m = round(extent_m, 2),
                ))

            return RadarScanResult(
                timestamp  = 0.0,
                detections = detections,
                sweep_data = sweep_data,
            )

        finally:
            for el, was_enabled, w in zip(
                self.config.elements, original_enabled, original_apod_weights
            ):
                el.enabled            = was_enabled
                el.apodization_weight = w
            self.config.apodization_window = original_apod
            self.config.steering_angle     = original_steering
            self.config.calculate_steering_delays()

    def compute_beamforming_4face(self, steering_angle: float | None = None) -> "BeamformingResult":
        """
        Full 360° beam pattern of the single array (boresight = North).
        Name kept for API compatibility.
        """
        if steering_angle is not None:
            self.config.steering_angle = steering_angle
            self.config.calculate_steering_delays()

        angles_deg = np.arange(0, 360, 1.0)
        angles_rad = np.deg2rad(angles_deg)

        active_els = [el for el in self.config.elements if el.enabled]
        if not active_els:
            dummy_db = np.full(len(angles_deg), -100.0)
            ds = 20
            return BeamformingResult(
                beam_pattern_db = dummy_db[::ds].tolist(),
                angles_deg      = angles_deg[::ds].tolist(),
                beam_angle      = self.config.steering_angle,
                side_lobe_level = -100.0,
                main_lobe_width = 0.0,
            )

        x_base = self.config._element_x_positions()[
            [i for i, el in enumerate(self.config.elements) if el.enabled]
        ]

        freqs       = np.array([el.frequency           for el in active_els])
        ks          = 2.0 * np.pi * freqs / self.config.wave_speed
        base_phases = (
            np.array([el.get_phase_radians() for el in active_els])
            - (2.0 * np.pi * freqs * np.array([el.time_delay for el in active_els]))
        )
        amps = np.array(
            [(el.intensity / 100.0) * el.apodization_weight for el in active_els]
        )

        # Far-field array factor: AF(θ) = Σ A · exp(j(φ_base + k·x·sin(θ)))
        spatial  = ks[:, None] * x_base[:, None] * np.sin(angles_rad)[None, :]
        phasors  = amps[:, None] * np.exp(1j * (base_phases[:, None] + spatial))
        total_af = np.sum(phasors, axis=0)

        beam_pattern = np.abs(total_af)
        max_val = np.max(beam_pattern)
        if max_val > 0:
            beam_pattern /= max_val

        noise_std    = 10 ** (-self.config.snr / 20)
        beam_pattern = np.clip(
            beam_pattern + np.random.normal(0, noise_std, beam_pattern.shape), 0, None
        )
        beam_pattern /= np.max(beam_pattern)

        beam_pattern_db = 20.0 * np.log10(np.clip(beam_pattern, 1e-12, None))

        peak_idx  = int(np.argmax(beam_pattern_db))
        left_idx  = peak_idx
        while left_idx > 0 and beam_pattern_db[left_idx - 1] >= -3.0:
            left_idx -= 1
        right_idx = peak_idx
        while right_idx < len(beam_pattern_db) - 1 and beam_pattern_db[right_idx + 1] >= -3.0:
            right_idx += 1

        main_lobe_width  = float(angles_deg[right_idx] - angles_deg[left_idx])
        side_lobe_mask   = np.ones(len(beam_pattern_db), dtype=bool)
        side_lobe_mask[left_idx:right_idx + 1] = False
        side_lobe_level  = (
            float(np.max(beam_pattern_db[side_lobe_mask]))
            if np.any(side_lobe_mask) else -100.0
        )

        ds = 20
        return BeamformingResult(
            beam_pattern_db = beam_pattern_db[::ds].tolist(),
            angles_deg      = angles_deg[::ds].tolist(),
            beam_angle      = self.config.steering_angle,
            side_lobe_level = side_lobe_level,
            main_lobe_width = main_lobe_width,
        )

    @staticmethod
    def _log_compress(
        power_bins: np.ndarray,
        dynamic_range_db: float = 40.0,
    ) -> np.ndarray:
        eps      = 1e-30
        safe     = np.where(np.isfinite(power_bins), power_bins, eps)
        power_db = 10.0 * np.log10(np.maximum(safe, eps))
        peak_db  = float(np.max(power_db))
        floor_db = peak_db - dynamic_range_db
        return np.clip((power_db - floor_db) / dynamic_range_db, 0.0, 1.0)


    @staticmethod
    def _downsample_bins(bins: np.ndarray, max_bins: int = 300) -> np.ndarray:
        """Average-pool `bins` down to at most `max_bins` points for transport."""
        n = len(bins)
        if n <= max_bins:
            return bins
        factor = math.ceil(n / max_bins)
        trim   = factor * max_bins
        padded = np.resize(bins, trim)
        return padded.reshape(max_bins, factor).mean(axis=1)