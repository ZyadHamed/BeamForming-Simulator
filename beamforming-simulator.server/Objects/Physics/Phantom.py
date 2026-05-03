import numpy as np
from dataclasses import dataclass
from typing import List

from Objects.Physics.TargetEnviroment import Scatterer, TargetEnvironment 

@dataclass
class TissueRegion:
    """
    A single tissue region defined entirely by the user.
    """
    name: str
    center_x: float         # mm, lateral
    center_z: float         # mm, axial depth
    semi_axis_x: float      # mm, half-width
    semi_axis_z: float      # mm, half-height
    rotation_deg: float     # degrees, tilt of the ellipse

    # Acoustic tissue properties
    speed_of_sound: float
    attenuation_db_per_cm_mhz: float
    density_kg_m3: float
    is_fluid: bool

    @property
    def acoustic_impedance(self) -> float:
        """Z = density * speed of sound"""
        return self.density_kg_m3 * self.speed_of_sound

    def contains_point(self, x: float, z: float) -> bool:
        """Check if a spatial point (x, z) falls inside this ellipse."""
        cos_r = np.cos(np.deg2rad(self.rotation_deg))
        sin_r = np.sin(np.deg2rad(self.rotation_deg))
        dx = x - self.center_x
        dz = z - self.center_z
        x_rot = dx * cos_r + dz * sin_r
        z_rot = -dx * sin_r + dz * cos_r
        return (x_rot / self.semi_axis_x)**2 + (z_rot / self.semi_axis_z)**2 <= 1.0


class Phantom:
    """
    Encapsulates a generic phantom. The user MUST supply the region geometries
    and acoustic properties at instantiation.
    """
    def __init__(self, regions: List[TissueRegion], scale_mm: float):
        """
        Initializes the Phantom purely from user input.

        :param regions: A list of TissueRegion objects containing user-defined values.
        :param scale_mm: The physical scale/bounding box of the phantom.
        """
        self.regions = regions
        self.scale_mm = scale_mm

    def get_scatterer_environment(
        self,
        grid_spacing_mm: float = 3.0,
        noise_density: float = 0.1,
        n_boundary: int = 40
    ) -> TargetEnvironment:
        """
        Translates the user's tissue regions into a scatterer point cloud.
        """
        rng = np.random.default_rng(42)
        scatterers = []
        half = self.scale_mm / 2.0
        Z_ambient = 1000 * 1500

        # Boundary scatterers
        for idx, region in enumerate(self.regions):
            thetas = np.linspace(0, 2 * np.pi, n_boundary, endpoint=False)
            for theta in thetas:
                bx = region.semi_axis_x * np.cos(theta)
                bz = region.semi_axis_z * np.sin(theta)
                cos_r = np.cos(np.deg2rad(region.rotation_deg))
                sin_r = np.sin(np.deg2rad(region.rotation_deg))
                rx = bx * cos_r - bz * sin_r + region.center_x
                rz = bx * sin_r + bz * cos_r + region.center_z

                if abs(rx) < half:
                    Z_outside = Z_ambient
                    for i in range(idx - 1, -1, -1):
                        if self.regions[i].contains_point(rx, rz):
                            Z_outside = self.regions[i].acoustic_impedance
                            break
                    Z_inside = region.acoustic_impedance
                    R = abs((Z_inside - Z_outside) / (Z_inside + Z_outside))
                    refl = R * 5.0 * (0.9 + 0.1 * rng.random())
                    scatterers.append(Scatterer(x=rx, z=rz, reflectivity=refl))

        # Internal speckle scatterers
        xs = np.arange(-half, half, grid_spacing_mm)
        zs = np.arange(-half, half, grid_spacing_mm)
        for x in xs:
            for z in zs:
                if rng.random() > noise_density: continue
                for region in reversed(self.regions):
                    if region.contains_point(x, z):
                        if region.is_fluid:
                            refl = rng.random() * 0.001
                        else:
                            base_speckle = 0.02 * (region.density_kg_m3 / 1000.0)
                            refl = max(0, rng.normal(base_speckle, base_speckle * 0.3))
                        scatterers.append(Scatterer(x=x, z=z, reflectivity=refl))
                        break

        print(f"Phantom built: {len(scatterers)} scatterers based on user inputs.")
        return TargetEnvironment(scatterers=scatterers, background_noise_level=0.005)