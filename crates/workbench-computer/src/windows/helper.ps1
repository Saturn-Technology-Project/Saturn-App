
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Web.Extensions, System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase
$source = [System.IO.File]::ReadAllText($args[0])
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Core, System.Drawing, System.Web.Extensions, System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase
[WorkbenchDesktop]::Serve()
