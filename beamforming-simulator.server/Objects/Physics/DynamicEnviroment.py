from dataclasses import dataclass, field
from typing import List
import numpy as np

from Objects.Physics.TargetEnviroment import Scatterer, TargetEnvironment

@dataclass
class MovingScatterer(Scatterer):
    """A point-target that moves over time."""
    vx: float = 0.0  # Lateral velocity (mm/s)
    vz: float = 0.0  # Axial velocity (mm/s)

@dataclass
class DynamicEnvironment(TargetEnvironment):
    """An environment that can advance in time."""
    time_elapsed_s: float = 0.0

    def advance_time(self, dt_seconds: float):
        """Moves all scatterers based on their velocities and the time elapsed."""
        for s in self.scatterers:
            if isinstance(s, MovingScatterer):
                s.x += s.vx * dt_seconds
                s.z += s.vz * dt_seconds
        self.time_elapsed_s += dt_seconds

    @classmethod
    def create_vessel(
        cls,
        start_pos: tuple[float, float],
        direction_vector: tuple[float, float],
        radius_mm: float,
        velocity_magnitude_mms: float,
        num_blood_cells: int,
        background_noise: float = 0.01
    ) -> 'DynamicEnvironment':
        """
        Helper to spawn a customized blood vessel.
        direction_vector should be (x, z).
        """
        dir_x, dir_z = direction_vector
        # Normalize direction vector
        norm = np.sqrt(dir_x**2 + dir_z**2)
        dir_x, dir_z = dir_x / norm, dir_z / norm

        scatterers = []

        # Create parabolic flow profile (Poiseuille flow) inside the vessel
        for _ in range(num_blood_cells):
            # Random position along the vessel length
            length_offset = np.random.uniform(0, 40) # 40mm long vessel segment
            # Random radial offset from the center of the vessel
            radial_offset = np.random.uniform(-radius_mm, radius_mm)

            # Position: Centerline + radial offset (perpendicular to direction)
            perp_x, perp_z = -dir_z, dir_x

            x = start_pos[0] + (dir_x * length_offset) + (perp_x * radial_offset)
            z = start_pos[1] + (dir_z * length_offset) + (perp_z * radial_offset)

            # Parabolic velocity (fastest in center, 0 at walls)
            flow_profile = 1.0 - (radial_offset / radius_mm)**2
            v_mag = velocity_magnitude_mms * flow_profile

            scatterers.append(MovingScatterer(
                x=x, z=z,
                reflectivity=np.random.uniform(0.1, 0.5), # Blood is weakly scattering
                vx=dir_x * v_mag,
                vz=dir_z * v_mag
            ))

        return cls(scatterers=scatterers, background_noise_level=background_noise)