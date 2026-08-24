"""Public errors raised at interoperability boundaries."""


class InteropError(RuntimeError):
    """Base class for expected interoperability failures."""


class ProtocolError(InteropError):
    """The peer returned malformed or incompatible protocol data."""


class PermissionDeniedError(InteropError):
    """A requested operation was outside an explicit permission boundary."""


class LimitExceededError(InteropError):
    """A configured byte, item, or time limit was exceeded."""
