import os
from pkg.service import Service, helper as imported_helper
import pkg.service as service_module
import pkg.service


def traced(function):
    return function


@traced
def entry(name):
    imported_helper(name)
    service_module.utility()
    pkg.service.utility()
    return runtime_target(name)


def shadowed(helper):
    return helper()


async def async_entry():
    imported_helper("async")


class Runner:
    @staticmethod
    def build():
        return Service()

    def run(self):
        self.finish()

    def finish(self):
        return imported_helper("done")

    def outer(self):
        def nested(value):
            return helper_missing(value)
        return nested("value")


if __name__ == "__main__":
    entry("start")
