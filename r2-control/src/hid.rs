//! Direct Windows HID primitives recovered from the native helper's hid-normal vtable.
//! No vendor process, command checksum, or receiver routing policy is implemented here.
//! Evidence: tools/native/evidence/hid-normal-{a,b,c,d}.c (0x567fc0/0x5682a0/0x568690/0x568970).
use anyhow::{bail,Result};
use serde::{Deserialize,Serialize};

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct HidDeviceInfo {
    pub path:String, pub vid:u16, pub pid:u16, pub version:u16,
    pub usage_page:u16, pub usage:u16,
    pub input_report_byte_length:u16, pub output_report_byte_length:u16,
    pub feature_report_byte_length:u16,
}
impl HidDeviceInfo {
    /// These interface attributes are shared by several models; a later read must identify R2.
    pub fn is_r2_candidate(&self)->bool {
        self.vid==0x3151&&[0x402d,0x4026,0x402a].contains(&self.pid)
            &&self.usage_page==65535&&self.usage==2&&self.feature_report_byte_length==65
    }
}
pub fn prepare_normal(payload:&[u8],checksum_type:u8)->Result<Vec<u8>> {
    if payload.len()>66 {bail!("Feature payload exceeds native66-byte buffer")}
    let mut out=payload.to_vec();out.resize(66,0);
    match checksum_type {0=>{out[7]=!out[..7].iter().fold(0u8,|sum,v|sum.wrapping_add(*v));},1=>{out[8]=!out[..8].iter().fold(0u8,|sum,v|sum.wrapping_add(*v));},2=>{},_=>bail!("Unknown checksum type")}
    Ok(out)
}
pub fn feature_report(payload:&[u8])->Result<Vec<u8>> {
    let padded=prepare_normal(payload,2)?;
    let mut report=Vec::with_capacity(67);report.push(0);report.extend(padded);Ok(report)
}
pub fn route_payload(route:u8)->Result<Vec<u8>> {
    if route>2{bail!("Route must be NONE0,KEYBOARD1,MOUSE2")}
    prepare_normal(&[0xf6,((0x0d050au32>>((route as u32)*8))&255)as u8],2)
}
pub fn interrupt_report(payload:&[u8])->Result<Vec<u8>> {
    if payload.len()>66 {bail!("Interrupt payload exceeds native66-byte buffer")}
    let mut report=Vec::with_capacity(payload.len()+1);report.push(6);report.extend(payload);Ok(report)
}
pub fn strip_report_id(report:&[u8])->Result<Vec<u8>> {
    if report.is_empty(){bail!("Empty HID report")}
    Ok(report[1..].to_vec())
}

#[cfg(windows)] mod win {
    use super::*;
    use anyhow::anyhow;
    use std::{ffi::c_void,mem::{size_of,zeroed},ptr::{null,null_mut}};
    type Handle=*mut c_void;
    const INVALID_HANDLE:Handle=(-1isize)as Handle;
    const GENERIC_READ:u32=0x80000000;
    const GENERIC_WRITE:u32=0x40000000;
    const FILE_SHARE_READ:u32=1;const FILE_SHARE_WRITE:u32=2;
    const OPEN_EXISTING:u32=3;const FILE_FLAG_OVERLAPPED:u32=0x40000000;
    const ERROR_NO_MORE_ITEMS:u32=259;const ERROR_IO_PENDING:u32=997;
    const WAIT_OBJECT_0:u32=0;const WAIT_TIMEOUT:u32=258;
    #[repr(C)]#[derive(Clone,Copy)]struct Guid{data1:u32,data2:u16,data3:u16,data4:[u8;8]}
    #[repr(C)]struct InterfaceData{cb_size:u32,guid:Guid,flags:u32,reserved:usize}
    #[repr(C)]struct Attributes{size:u32,vid:u16,pid:u16,version:u16}
    #[repr(C)]struct Caps {
        usage:u16,usage_page:u16,input:u16,output:u16,feature:u16,reserved:[u16;17],
        link_nodes:u16,input_buttons:u16,input_values:u16,input_indices:u16,
        output_buttons:u16,output_values:u16,output_indices:u16,
        feature_buttons:u16,feature_values:u16,feature_indices:u16,
    }
    #[repr(C)]struct Overlapped{internal:usize,internal_high:usize,offset:u32,offset_high:u32,event:Handle}
    #[link(name="hid")]unsafe extern "system" {
        fn HidD_GetHidGuid(guid:*mut Guid);
        fn HidD_GetAttributes(handle:Handle,attributes:*mut Attributes)->u8;
        fn HidD_GetPreparsedData(handle:Handle,data:*mut *mut c_void)->u8;
        fn HidD_FreePreparsedData(data:*mut c_void)->u8;
        fn HidP_GetCaps(data:*const c_void,caps:*mut Caps)->i32;
        fn HidD_SetFeature(handle:Handle,report:*mut c_void,length:u32)->u8;
        fn HidD_GetFeature(handle:Handle,report:*mut c_void,length:u32)->u8;
    }
    #[link(name="setupapi")]unsafe extern "system" {
        fn SetupDiGetClassDevsW(guid:*const Guid,enumerator:*const u16,parent:Handle,flags:u32)->Handle;
        fn SetupDiEnumDeviceInterfaces(set:Handle,device:*mut c_void,guid:*const Guid,index:u32,data:*mut InterfaceData)->i32;
        fn SetupDiGetDeviceInterfaceDetailW(set:Handle,data:*mut InterfaceData,detail:*mut c_void,size:u32,required:*mut u32,device:*mut c_void)->i32;
        fn SetupDiDestroyDeviceInfoList(set:Handle)->i32;
    }
    #[link(name="kernel32")]unsafe extern "system" {
        fn CreateFileW(path:*const u16,access:u32,share:u32,security:*const c_void,creation:u32,flags:u32,template:Handle)->Handle;
        fn CloseHandle(handle:Handle)->i32;
        fn GetLastError()->u32;
        fn CreateEventW(security:*const c_void,manual:i32,initial:i32,name:*const u16)->Handle;
        fn ReadFile(handle:Handle,buffer:*mut c_void,count:u32,read:*mut u32,overlapped:*mut Overlapped)->i32;
        fn WriteFile(handle:Handle,buffer:*const c_void,count:u32,written:*mut u32,overlapped:*mut Overlapped)->i32;
        fn WaitForSingleObject(handle:Handle,milliseconds:u32)->u32;
        fn GetOverlappedResult(handle:Handle,overlapped:*mut Overlapped,transferred:*mut u32,wait:i32)->i32;
        fn CancelIoEx(handle:Handle,overlapped:*mut Overlapped)->i32;
    }
    fn last_error(operation:&str)->anyhow::Error {
        let code=unsafe{GetLastError()};anyhow!("{}: {} (Win32 {})",operation,std::io::Error::from_raw_os_error(code as i32),code)
    }
    fn wide(path:&str)->Result<Vec<u16>>{
        if path.contains('\0'){bail!("HID path contains a null byte")}
        Ok(path.encode_utf16().chain(Some(0)).collect())
    }
    struct OwnedHandle(usize);
    impl OwnedHandle{fn raw(&self)->Handle{self.0 as Handle}}
    impl Drop for OwnedHandle{fn drop(&mut self){unsafe{CloseHandle(self.raw());}}}
    struct DeviceSet(Handle);
    impl Drop for DeviceSet{fn drop(&mut self){unsafe{SetupDiDestroyDeviceInfoList(self.0);}}}
    fn open(path:&str,access:u32,flags:u32)->Result<OwnedHandle>{
        let path=wide(path)?;
        let handle=unsafe{CreateFileW(path.as_ptr(),access,FILE_SHARE_READ|FILE_SHARE_WRITE,null(),OPEN_EXISTING,flags,null_mut())};
        if handle==INVALID_HANDLE{return Err(last_error("CreateFileW HID"))}
        Ok(OwnedHandle(handle as usize))
    }
    fn describe(path:String)->Result<HidDeviceInfo>{
        // Attribute/capability inspection uses zero desired access, allowing protected HID collections.
        let handle=open(&path,0,0)?;
        let mut attrs:Attributes=unsafe{zeroed()};attrs.size=size_of::<Attributes>()as u32;
        if unsafe{HidD_GetAttributes(handle.raw(),&mut attrs)}==0{return Err(last_error("HidD_GetAttributes"))}
        let mut preparsed=null_mut();
        if unsafe{HidD_GetPreparsedData(handle.raw(),&mut preparsed)}==0{return Err(last_error("HidD_GetPreparsedData"))}
        let mut caps:Caps=unsafe{zeroed()};
        let status=unsafe{HidP_GetCaps(preparsed,&mut caps)};
        unsafe{HidD_FreePreparsedData(preparsed);}
        if status!=0x00110000{bail!("HidP_GetCaps NTSTATUS 0x{:08x}",status)}
        Ok(HidDeviceInfo{path,vid:attrs.vid,pid:attrs.pid,version:attrs.version,
            usage_page:caps.usage_page,usage:caps.usage,input_report_byte_length:caps.input,
            output_report_byte_length:caps.output,feature_report_byte_length:caps.feature})
    }
    pub fn enumerate_hid()->Result<Vec<HidDeviceInfo>>{
        let mut guid:Guid=unsafe{zeroed()};unsafe{HidD_GetHidGuid(&mut guid)};
        let handle=unsafe{SetupDiGetClassDevsW(&guid,null(),null_mut(),2|16)};
        if handle==INVALID_HANDLE{return Err(last_error("SetupDiGetClassDevsW"))}
        let set=DeviceSet(handle);let mut out=vec![];let mut index=0;
        loop{
            let mut interface:InterfaceData=unsafe{zeroed()};interface.cb_size=size_of::<InterfaceData>()as u32;
            if unsafe{SetupDiEnumDeviceInterfaces(set.0,null_mut(),&guid,index,&mut interface)}==0{
                if unsafe{GetLastError()}==ERROR_NO_MORE_ITEMS{break}return Err(last_error("SetupDiEnumDeviceInterfaces"));
            }
            index+=1;let mut required=0;
            unsafe{SetupDiGetDeviceInterfaceDetailW(set.0,&mut interface,null_mut(),0,&mut required,null_mut());}
            if required<6||required>1024*1024{bail!("Invalid HID interface path size {}",required)}
            // u64 allocation guarantees native detail structure alignment; DevicePath starts at byte4.
            let mut storage=vec![0u64;(required as usize+7)/8];
            let raw=storage.as_mut_ptr()as *mut u8;
            unsafe{(raw as *mut u32).write(if cfg!(target_pointer_width="64"){8}else{6});}
            if unsafe{SetupDiGetDeviceInterfaceDetailW(set.0,&mut interface,raw.cast(),required,&mut required,null_mut())}==0{return Err(last_error("SetupDiGetDeviceInterfaceDetailW"))}
            let path=unsafe{std::slice::from_raw_parts(raw.add(4)as *const u16,(required as usize-4)/2)};
            let end=path.iter().position(|v|*v==0).unwrap_or(path.len());
            let path=String::from_utf16_lossy(&path[..end]);
            // Devices can disappear between enumeration/open. Skip inaccessible collections.
            if let Ok(info)=describe(path){out.push(info)}
        }Ok(out)
    }
    /// Synchronous feature handle. Use from spawn_blocking; serialize device operations externally.
    struct PendingRead{buffer:Vec<u8>,event:OwnedHandle,ov:Box<Overlapped>,handle:usize,pending:bool,complete:Option<usize>}
    impl Drop for PendingRead{fn drop(&mut self){if self.pending{let mut count=0;unsafe{CancelIoEx(self.handle as Handle,&mut *self.ov);GetOverlappedResult(self.handle as Handle,&mut *self.ov,&mut count,1);}}}}
    pub struct HidDevice{path:String,handle:OwnedHandle,interrupt_handle:OwnedHandle,route:Option<u8>,input_len:usize,pending_read:Option<PendingRead>}
    // Handles are thread-independent, and pending I/O points into stable heap allocations.
    // All I/O methods require exclusive &mut self; moving this owner cannot invalidate buffers.
    unsafe impl Send for HidDevice {}
    impl Drop for HidDevice{fn drop(&mut self){self.pending_read.take();}}
    impl HidDevice{
        pub fn open(path:&str)->Result<Self>{Ok(Self{path:path.into(),handle:open(path,GENERIC_READ|GENERIC_WRITE,0)?,interrupt_handle:open(path,GENERIC_READ|GENERIC_WRITE,FILE_FLAG_OVERLAPPED)?,route:None,input_len:describe(path.into()).map(|i|i.input_report_byte_length as usize).unwrap_or(66).max(1),pending_read:None})}
        pub fn path(&self)->&str{&self.path}
        /// Native dispatcher pads66, method0 prependsID0 =>67 bytes, as original hidapi call.
        /// Checksum/routing is caller-owned; prefer send_command/exchange for ordinary commands.
        pub fn send_feature(&mut self,payload:&[u8])->Result<()>{let mut report=feature_report(payload)?;
            if unsafe{HidD_SetFeature(self.handle.raw(),report.as_mut_ptr().cast(),report.len()as u32)}==0{return Err(last_error("HidD_SetFeature"))}Ok(())}
        pub fn send_command(&mut self,payload:&[u8],checksum_type:u8)->Result<()> {self.send_feature(&prepare_normal(payload,checksum_type)?)}
        pub fn select_route(&mut self,route:u8)->Result<()> {
            if self.route!=Some(route){self.send_feature(&route_payload(route)?)?;std::thread::sleep(std::time::Duration::from_millis(10));self.route=Some(route);}Ok(())
        }
        /// Blocking send/read pair; receiver route2 selects mouse. No write classification is inferred.
        pub fn exchange(&mut self,payload:&[u8],checksum_type:u8,route:Option<u8>)->Result<Vec<u8>> {
            if let Some(route)=route{self.select_route(route)?;}self.send_command(payload,checksum_type)?;
            std::thread::sleep(std::time::Duration::from_millis(5));self.get_feature()
        }
        /// Native method1: fetch65 bytes with report ID0, then remove first byte.
        pub fn get_feature(&mut self)->Result<Vec<u8>>{let mut report=vec![0u8;65];
            if unsafe{HidD_GetFeature(self.handle.raw(),report.as_mut_ptr().cast(),65)}==0{return Err(last_error("HidD_GetFeature"))}strip_report_id(&report)}
        /// Native method2: report ID6 followed by payload through hid_write/WriteFile.
        pub fn interrupt_write(&mut self,payload:&[u8],timeout_ms:u32)->Result<()> {
            let mut report=interrupt_report(payload)?;let count=self.interrupt_io(&mut report,true,timeout_ms)?;
            if count!=report.len(){bail!("Short HID interrupt write: {} of {}",count,report.len())}Ok(())
        }
        /// Native method3: allocate66, wait at most1000ms by default, strip first received byte.
        pub fn read_timeout(&mut self,timeout_ms:u32)->Result<Vec<u8>> {
            if self.pending_read.is_none(){
                let event=unsafe{CreateEventW(null(),1,0,null())};if event.is_null(){return Err(last_error("CreateEventW read"))}
                let event=OwnedHandle(event as usize);let mut ov:Box<Overlapped>=Box::new(unsafe{zeroed()});ov.event=event.raw();
                let mut read=PendingRead{buffer:vec![0;self.input_len],event,ov,handle:self.interrupt_handle.0,pending:false,complete:None};let mut count=0;
                let ok=unsafe{ReadFile(self.interrupt_handle.raw(),read.buffer.as_mut_ptr().cast(),read.buffer.len()as u32,&mut count,&mut *read.ov)};
                if ok!=0{read.complete=Some(count as usize);}else if unsafe{GetLastError()}==ERROR_IO_PENDING{read.pending=true;}else{return Err(last_error("ReadFile HID"))}
                self.pending_read=Some(read);
            }
            let read=self.pending_read.as_mut().unwrap();
            let count=if let Some(count)=read.complete{count}else{
                let wait=unsafe{WaitForSingleObject(read.event.raw(),timeout_ms)};
                // Match hidapi: retain the outstanding read/buffer/event across ordinary timeouts.
                if wait==WAIT_TIMEOUT{bail!("HID read timed out after {}ms; pending read retained",timeout_ms)}
                if wait!=WAIT_OBJECT_0{return Err(last_error("WaitForSingleObject read"))}
                let mut count=0;if unsafe{GetOverlappedResult(self.interrupt_handle.raw(),&mut *read.ov,&mut count,0)}==0{return Err(last_error("GetOverlappedResult read"))}
                read.pending=false;count as usize
            };
            let read=self.pending_read.take().unwrap();
            if count>read.buffer.len(){bail!("Invalid input report length")}
            let report=&read.buffer[..count];
            // hidapi strips zero reportID; hid_normal's upper method strips another leading byte.
            let hidapi_report=if report.first()==Some(&0){&report[1..]}else{report};
            strip_report_id(&hidapi_report[..hidapi_report.len().min(66)])
        }
        fn interrupt_io(&self,buffer:&mut [u8],write:bool,timeout_ms:u32)->Result<usize>{
            let handle=&self.interrupt_handle;
            let event=unsafe{CreateEventW(null(),1,0,null())};if event.is_null(){return Err(last_error("CreateEventW HID"))}
            let event=OwnedHandle(event as usize);let mut ov:Overlapped=unsafe{zeroed()};ov.event=event.raw();let mut transferred=0;
            let ok=unsafe{if write{WriteFile(handle.raw(),buffer.as_ptr().cast(),buffer.len()as u32,&mut transferred,&mut ov)}else{ReadFile(handle.raw(),buffer.as_mut_ptr().cast(),buffer.len()as u32,&mut transferred,&mut ov)}};
            if ok!=0{return Ok(transferred as usize)}
            if unsafe{GetLastError()}!=ERROR_IO_PENDING{return Err(last_error(if write{"WriteFile HID"}else{"ReadFile HID"}))}
            let wait=unsafe{WaitForSingleObject(event.raw(),timeout_ms)};
            if wait!=WAIT_OBJECT_0{
                // Drain completion before buffer/OVERLAPPED/handle destruction, including cancellation races.
                unsafe{CancelIoEx(handle.raw(),&mut ov);GetOverlappedResult(handle.raw(),&mut ov,&mut transferred,1);}
                if wait==WAIT_TIMEOUT{bail!("HID interrupt operation timed out after {}ms",timeout_ms)}
                return Err(last_error("WaitForSingleObject HID"));
            }
            if unsafe{GetOverlappedResult(handle.raw(),&mut ov,&mut transferred,0)}==0{return Err(last_error("GetOverlappedResult HID"))}
            if transferred as usize>buffer.len(){bail!("Invalid HID transfer length")}
            Ok(transferred as usize)
        }
    }
    #[test]fn ffi_layout(){assert_eq!(size_of::<Caps>(),64);assert_eq!(size_of::<Attributes>(),12);assert_eq!(size_of::<InterfaceData>(),if cfg!(target_pointer_width="64"){32}else{28});assert_eq!(size_of::<Overlapped>(),if cfg!(target_pointer_width="64"){32}else{20});}
}
#[cfg(windows)]pub use win::{enumerate_hid,HidDevice};
#[cfg(not(windows))]pub fn enumerate_hid()->Result<Vec<HidDeviceInfo>>{bail!("Direct HID transport requires Windows")}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn native_feature_framing(){let payload=[0xad;64];let report=feature_report(&payload).unwrap();assert_eq!(report.len(),67);assert_eq!(report[0],0);assert_eq!(&strip_report_id(&report).unwrap()[..64],&payload);}
    #[test]fn native_interrupt_framing(){let report=interrupt_report(&[0x85;64]).unwrap();assert_eq!(report[0],6);assert_eq!(report.len(),65);assert!(feature_report(&[0;67]).is_err());assert!(strip_report_id(&[]).is_err());}
    #[test]fn native_checksum_and_mouse_route(){let p=prepare_normal(&[0x85],0).unwrap();assert_eq!(p.len(),66);assert_eq!(p[7],0x7a);let p=prepare_normal(&[1,2,3,4,5,6,7,8],1).unwrap();assert_eq!(p[8],255-36);let route=route_payload(2).unwrap();assert_eq!(&route[..2],&[0xf6,0x0d]);assert_eq!(route[7],0);}
    #[test]fn discovery_filter_checks_usage_and_length(){let mut info=HidDeviceInfo{path:"test".into(),vid:0x3151,pid:0x402d,version:0,usage_page:65535,usage:2,input_report_byte_length:65,output_report_byte_length:65,feature_report_byte_length:65};assert!(info.is_r2_candidate());info.usage=1;assert!(!info.is_r2_candidate());}
}
