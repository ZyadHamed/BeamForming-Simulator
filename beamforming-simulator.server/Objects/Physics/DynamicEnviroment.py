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
    time_elapsed_s: float = 0.0
    
    # Store vessel geometry for wrapping
    _vessel_start: tuple = (0.0, 0.0)
    _vessel_dir: tuple = (1.0, 0.0)
    _vessel_length: float = 40.0
    _vessel_radius: float = 4.0

    def advance_time(self, dt_seconds: float):
        """Moves all scatterers and wraps them within the vessel."""
        for s in self.scatterers:
            if isinstance(s, MovingScatterer):
                s.x += s.vx * dt_seconds
                s.z += s.vz * dt_seconds

                # Project position onto vessel axis to check bounds
                dx = s.x - self._vessel_start[0]
                dz = s.z - self._vessel_start[1]
                
                dir_x, dir_z = self._vessel_dir
                
                # Distance along vessel axis
                along_axis = dx * dir_x + dz * dir_z
                
                # Wrap around if past the end
                if along_axis > self._vessel_length:
                    overshoot = along_axis - self._vessel_length
                    s.x -= dir_x * self._vessel_length
                    s.z -= dir_z * self._vessel_length
                elif along_axis < 0:
                    s.x += dir_x * self._vessel_length
                    s.z += dir_z * self._vessel_length

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
        dir_x, dir_z = direction_vector
        norm = np.sqrt(dir_x**2 + dir_z**2)
        dir_x, dir_z = dir_x / norm, dir_z / norm

        vessel_length = 40.0
        scatterers = []

        for _ in range(num_blood_cells):
            length_offset = np.random.uniform(0, vessel_length)
            radial_offset = np.random.uniform(-radius_mm, radius_mm)

            perp_x, perp_z = -dir_z, dir_x

            x = start_pos[0] + (dir_x * length_offset) + (perp_x * radial_offset)
            z = start_pos[1] + (dir_z * length_offset) + (perp_z * radial_offset)

            flow_profile = 1.0 - (radial_offset / radius_mm)**2
            v_mag = velocity_magnitude_mms * flow_profile

            scatterers.append(MovingScatterer(
                x=x, z=z,
                reflectivity=np.random.uniform(0.1, 0.5),
                vx=dir_x * v_mag,
                vz=dir_z * v_mag
            ))

        env = cls(scatterers=scatterers, background_noise_level=background_noise)
        # Store vessel geometry for wrapping
        env._vessel_start = start_pos
        env._vessel_dir = (dir_x, dir_z)
        env._vessel_length = vessel_length
        env._vessel_radius = radius_mm
        return env