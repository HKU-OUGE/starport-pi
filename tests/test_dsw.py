import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/'scripts'/(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


identity, proxy = module('dsw_identity'), module('dsw_proxy')


class DswConnection(unittest.TestCase):
    def test_full_arguments_and_ssh_hostname(self):
        instance = 'dsw-' + 'example1234567890'
        command = '"/home/example/bin/example-dsw-proxy-connect" %h'
        self.assertEqual(identity.instance_from_proxy_command(command, instance), instance)
        self.assertEqual(identity.instance_from_proxy_command('ProxyClient --instance-id='+instance), instance)
        self.assertEqual(identity.instance_from_proxy_command('ProxyClient --instance-id %h', instance), instance)
        for bad in ['example-dsw-proxy-connect', 'example-dsw-proxy-connect dsw-proxy', 'ProxyClient --instance-id=%h']:
            with self.assertRaises(ValueError):
                identity.instance_from_proxy_command(bad)
        with self.assertRaises(ValueError):
            identity.instance_from_proxy_command('ProxyClient '+instance, 'dsw-'+'different12345678')
        with self.assertRaises(ValueError):
            identity.instance_from_proxy_command('ProxyClient '+instance+' dsw-'+'different12345678')

    def test_cloud_errors_are_classified_without_forwarding_details(self):
        self.assertEqual(proxy.classify_error('StatusCode: 400\nCode: ValidationError\nMessage: Entity does not exist.'), 'dsw_instance_not_found_check_id_and_region')
        self.assertEqual(proxy.classify_error('Forbidden.RAM paidsw:GetToken denied'), 'dsw_token_permission_denied')
        self.assertEqual(proxy.classify_error('InvalidAccessKeyId example-private-value'), 'dsw_credentials_rejected')
        self.assertEqual(proxy.classify_error('unknown diagnostic example-private-value'), 'dsw_connection_failed')


if __name__ == '__main__':
    unittest.main()
