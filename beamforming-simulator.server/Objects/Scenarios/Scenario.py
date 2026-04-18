from abc import ABC, abstractmethod
from typing import List, Optional, Any
from Objects.ArrayConfig import ArrayConfig
from Objects.Physics.TargetEnviroment import TargetEnvironment

class Scenario(ABC):
    """
    Abstract base class for all wave-propagation environments.
    Manages shared state and acts as the wrapper for the core physics engine.
    """
    def __init__(self, config: 'ArrayConfig', environment: 'TargetEnvironment'):
        self.config = config
        self.environment = environment
        # Both scenarios will eventually share the same underlying physics engine
        # self._engine = PulseEchoEngine(self.config, self.environment)

    def update_config(self, new_config: 'ArrayConfig') -> None:
        """Updates the transducer/antenna array parameters."""
        self.config = new_config
        # self._engine.update_config(new_config)

    def update_environment(self, new_environment: 'TargetEnvironment') -> None:
        """Updates the physical targets in the simulation space."""
        self.environment = new_environment
        # self._engine.update_environment(new_environment)

    @abstractmethod
    def perform_default_scan(self, *args, **kwargs) -> Any:
        """
        Forces every child class to implement a default scanning behavior.
        """
        pass