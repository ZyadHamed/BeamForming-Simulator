import numpy as np
from scipy.signal import fftconvolve


class PulseEchoEngine:
    """
    Computes raw RF channel data using a pulse-echo model.

    If `regions` (List[TissueRegion]) is supplied, per-scatterer acoustic
    shadowing is applied BEFORE accumulating echoes.  This is the only correct
    place to do it: once all scatterer echoes are summed into a single RF
    waveform it is impossible to retroactively attenuate individual boundary
    reflections.

    Shadowing physics
    -----------------
    For every scatterer the engine computes a "shadow weight" = the product of
    transmission coefficients T_i = (1 - R_i) for every OTHER boundary scatterer
    that lies SHALLOWER than this scatterer AND within the beam's lateral footprint.
    R_i is the true pressure reflection coefficient derived from the stored
    reflectivity (which equals R ± small jitter, stored without the old *5 scaling).

    Effect:
      • Soft-tissue boundaries (R ≈ 0.01)  →  T ≈ 0.99  →  almost no shadow
      • Bone / calcification  (R ≈ 0.5-0.9) →  T ≈ 0.1-0.5  →  strong shadow
      • Two bone layers       →  shadow weight ≈ 0.01-0.25   →  near blackout
    """

    def __init__(self, array, environment, regions=None):
        self.array = array
        self.environment = environment
        self._regions = regions   # Optional List[TissueRegion]

    # ------------------------------------------------------------------
    # Shadow weight computation
    # ------------------------------------------------------------------
    def _compute_shadow_weights(self, scat_x, scat_z, scat_r, angle_rad):
        """
        Returns a 1-D array of shadow weights, one per scatterer.

        A scatterer at depth z receives weight = ∏ (1 - R_j) for all
        boundary scatterers j with z_j < z that lie within ±beam_width_mm
        of the beam centreline at their depth.
        """
        n = len(scat_x)
        weights = np.ones(n, dtype=float)

        if self._regions is None:
            return weights

        sin_a = np.sin(angle_rad)
        BEAM_HALF_WIDTH_MM = 3.0   # generous: captures all on-beam boundary scatterers

        # Only boundary scatterers cast shadows.
        # Boundary scatterers have meaningful R; speckle scatterers have R << 0.01.
        # After removing the *5 scaling, true boundary R ≥ ~0.005 (soft tissue)
        # up to ~0.9 (bone).  We shadow only with scatterers whose R > 0.005.
        SHADOW_THRESHOLD = 0.005
        is_boundary = scat_r > SHADOW_THRESHOLD

        if not np.any(is_boundary):
            return weights

        b_z   = scat_z[is_boundary]
        b_x   = scat_x[is_boundary]
        b_r   = scat_r[is_boundary]   # this IS the true R (post-fix reflectivity)

        # Sort boundary scatterers by depth for efficient forward march
        order   = np.argsort(b_z)
        b_z_s   = b_z[order]
        b_x_s   = b_x[order]
        b_r_s   = b_r[order]

        # Sort all scatterers by depth for the march
        all_order    = np.argsort(scat_z)
        all_order_inv = np.argsort(all_order)   # to restore original order at end

        sorted_z = scat_z[all_order]

        cum_T    = 1.0      # cumulative transmission so far
        b_ptr    = 0        # pointer into boundary array
        n_bound  = len(b_z_s)
        result   = np.ones(n, dtype=float)

        for rank, orig_idx in enumerate(all_order):
            depth = sorted_z[rank]

            # Advance boundary pointer: absorb all boundaries shallower than this depth
            while b_ptr < n_bound and b_z_s[b_ptr] < depth:
                bz = b_z_s[b_ptr]
                bx = b_x_s[b_ptr]
                br = b_r_s[b_ptr]

                # Is this boundary on the beam at its depth?
                beam_x_at_bz = bz * sin_a
                if abs(bx - beam_x_at_bz) <= BEAM_HALF_WIDTH_MM:
                    T = 1.0 - br
                    cum_T *= T

                b_ptr += 1

            result[orig_idx] = cum_T

        return result

    # ------------------------------------------------------------------
    # Main channel-data computation
    # ------------------------------------------------------------------
    def compute_channel_data(self, num_samples: int, sampling_rate_mhz: float):
        num_elements = len(self.array.elements)
        channel_data = np.zeros((num_elements, num_samples))

        t  = np.arange(num_samples) / sampling_rate_mhz
        c  = self.array.wave_speed
        fc = 5.0
        pulse_width = 0.2

        x_positions = self.array._element_x_positions()

        angle_rad = np.deg2rad(self.array.steering_angle)
        tx_delays = (x_positions * np.sin(angle_rad)) / c
        tx_delays -= np.min(tx_delays)

        scat_x = np.array([s.x          for s in self.environment.scatterers])
        scat_z = np.array([s.z          for s in self.environment.scatterers])
        scat_r = np.array([s.reflectivity for s in self.environment.scatterers])

        # ── Acoustic shadowing weights (per scatterer) ──────────────────────
        shadow_w = self._compute_shadow_weights(scat_x, scat_z, scat_r, angle_rad)
        scat_a   = scat_r * shadow_w     # effective echo amplitude

        # ── Vectorised distances ─────────────────────────────────────────────
        dx        = x_positions[:, np.newaxis] - scat_x[np.newaxis, :]
        dz        = scat_z[np.newaxis, :]
        distances = np.sqrt(dx**2 + dz**2)

        rx_tofs    = distances / c
        tx_tofs    = (distances / c) + tx_delays[:, np.newaxis]
        total_tofs = rx_tofs[:, np.newaxis, :] + tx_tofs[np.newaxis, :, :]

        tof_indices = (total_tofs * sampling_rate_mhz).astype(int)

        impulse_response = np.zeros((num_elements, num_samples))
        weights_flat = np.broadcast_to(
            scat_a[np.newaxis, :], (num_elements, len(scat_a))
        ).flatten()

        for rx in range(num_elements):
            idx_flat   = tof_indices[rx, :, :].flatten()
            valid_mask = (idx_flat >= 0) & (idx_flat < num_samples)
            rx_impulse = np.bincount(
                idx_flat[valid_mask],
                weights=weights_flat[valid_mask],
                minlength=num_samples
            )
            impulse_response[rx, :] = rx_impulse[:num_samples]

        # ── Pulse convolution ────────────────────────────────────────────────
        half_len  = int(3 * pulse_width * sampling_rate_mhz)
        t_pulse   = np.arange(-half_len, half_len + 1) / sampling_rate_mhz
        base_pulse = (np.cos(2 * np.pi * fc * t_pulse)
                      * np.exp(-(t_pulse**2) / (pulse_width**2)))

        for rx in range(num_elements):
            channel_data[rx, :] = fftconvolve(
                impulse_response[rx, :], base_pulse, mode='same'
            )

        return channel_data, t