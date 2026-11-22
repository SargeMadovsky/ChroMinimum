param(
 [Parameter(Mandatory=$true)][string]$ReadyFile,
 [Parameter(Mandatory=$true)][string]$Output,
 [string]$InvokeRuntimeId,
 [string]$SelectRuntimeId
)
$ErrorActionPreference='Stop'
if($InvokeRuntimeId -and $SelectRuntimeId){throw 'Select only one action'}
$taskTargetId=if($InvokeRuntimeId){$InvokeRuntimeId}else{$SelectRuntimeId}
$taskReady=Get-Content -LiteralPath $ReadyFile -Raw -Encoding utf8 | ConvertFrom-Json
$taskProcess=Get-Process -Id $taskReady.pid
if($taskProcess.Path -ne $taskReady.exe){throw 'Process path changed; refusing UI access'}
if([Math]::Abs(($taskProcess.StartTime.ToUniversalTime()-[DateTimeOffset]::FromUnixTimeMilliseconds($taskReady.start).UtcDateTime).TotalSeconds) -gt 5){throw 'Process start time changed'}
$taskFramework='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF'
Add-Type -Path (Join-Path $taskFramework 'UIAutomationTypes.dll')
Add-Type -Path (Join-Path $taskFramework 'UIAutomationClient.dll')
$taskCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$taskReady.pid)
$taskWindows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$taskCondition)
$taskRows=[Collections.Generic.List[object]]::new()
$taskSeen=[Collections.Generic.HashSet[string]]::new()
$taskSelected=$null
foreach($taskWindow in $taskWindows){
 $taskNodes=$taskWindow.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
 foreach($taskNode in $taskNodes){
  $taskId=($taskNode.GetRuntimeId() -join ',')
  if(-not $taskSeen.Add($taskId)){continue}
  $taskCurrent=$taskNode.Current
  $taskInvoke=$null
  $taskCanInvoke=$taskNode.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$taskInvoke)
  $taskRows.Add([pscustomobject]@{id=$taskId;name=$taskCurrent.Name;type=$taskCurrent.ControlType.ProgrammaticName;automationId=$taskCurrent.AutomationId;enabled=$taskCurrent.IsEnabled;offscreen=$taskCurrent.IsOffscreen;invoke=$taskCanInvoke;window=$taskWindow.Current.Name})
  if($taskTargetId -and $taskId -eq $taskTargetId){if($taskSelected){throw 'Ambiguous runtime id'};$taskSelected=$taskNode}
 }
}
$taskRows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output -Encoding utf8
if($taskTargetId){
 if(-not $taskSelected){throw 'Observed UI element no longer exists; reobserve'}
 if(-not $taskSelected.Current.IsEnabled -or $taskSelected.Current.IsOffscreen){throw 'Target not enabled/visible'}
 $taskPattern=$null
 $taskRequiredPattern=if($InvokeRuntimeId){[System.Windows.Automation.InvokePattern]::Pattern}else{[System.Windows.Automation.SelectionItemPattern]::Pattern}
 if(-not $taskSelected.TryGetCurrentPattern($taskRequiredPattern,[ref]$taskPattern)){throw 'Element has no requested pattern'}
 $taskAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 $taskName=$taskSelected.Current.Name
 $taskWatch=[Diagnostics.Stopwatch]::StartNew()
 if($InvokeRuntimeId){$taskPattern.Invoke()}else{$taskPattern.Select()}
 $taskResult=[pscustomobject]@{target=$taskTargetId;action=$(if($InvokeRuntimeId){'invoke'}else{'select'});name=$taskName;at=$taskAt;returnMs=$taskWatch.Elapsed.TotalMilliseconds}
 $taskResult | ConvertTo-Json | Set-Content -LiteralPath ($Output+'.invoke.json') -Encoding utf8
 $taskResult | ConvertTo-Json -Compress
}else{[pscustomobject]@{pid=$taskReady.pid;windows=$taskWindows.Count;elements=$taskRows.Count;output=$Output}|ConvertTo-Json -Compress}
