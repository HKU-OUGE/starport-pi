"""Read DSW identities from complete arguments, never from executable names."""
import re
import shlex


def valid_instance(value):
    return isinstance(value, str) and re.fullmatch(r'dsw-[a-z0-9]{12,64}', value) is not None


def instance_from_proxy_command(command, hostname=None):
    arguments = shlex.split(command)
    if not arguments:
        raise ValueError('dsw_instance_argument_missing')
    candidates = set()
    # argv[0] is the program. A path such as example-dsw-proxy-connect is not an ID.
    for argument in arguments[1:]:
        value = argument.removeprefix('--instance-id=')
        if value == '%h':
            value = hostname
        if valid_instance(value):
            candidates.add(value)
    if len(candidates) != 1:
        raise ValueError('dsw_instance_argument_missing_or_ambiguous')
    instance = candidates.pop()
    if valid_instance(hostname) and hostname != instance:
        raise ValueError('dsw_hostname_and_argument_disagree')
    return instance
