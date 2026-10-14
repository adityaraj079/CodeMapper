from pkg.app import entry


def helper(value: str) -> str:
    return value


def utility():
    return helper("utility")


class Service:
    def execute(self):
        return helper("service")
