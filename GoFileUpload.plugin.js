/**
 * @name GoFileUpload
 * @author PurelyAndy
 * @description Uploads files larger than the limit to GoFile and appends the links to your message
 * @version 1.0.0
 * @authorId 702958966308601957
 * @authorLink https://github.com/PurelyAndy
 * @source https://github.com/PurelyAndy/GoFileUpload
 * @runAt idle
 */

const { Webpack, Patcher, Data, React } = BdApi;
const Filters = Webpack.Filters;
const MessageActions = Webpack.getByKeys('jumpToMessage', '_sendMessage');
const CloudUploader = Webpack.getByPrototypeKeys('uploadFileToCloud', { searchExports: true });
const [CheckFilesModule, openModalIfFileExceedsSizeKey] = Webpack.getWithKey(
    Filters.byStrings('Unexpected mismatch between files and file metadata'),
    { target: Webpack.getModule(Webpack.Filters.bySource('Unexpected mismatch between files and file metadata')) }
)
const { getGuildMaxFileSize } = Webpack.getMangled(
    Filters.bySource('location:"getGuildMaxFileSize"'),
    { getGuildMaxFileSize: Filters.byStrings('location:"getGuildMaxFileSize"') }
);
const { getBiggestSize, getUserMaxFileSize } = Webpack.getMangled(
    Filters.bySource('Math.max(1048576'),
    {
        getBiggestSize: Filters.byStrings('Math.max(1048576'),
        getUserMaxFileSize: Filters.byStrings('let{location')
    }
);
const MessageStoreDispatcher = Webpack.Stores.MessageStore._dispatcher;
const MessageQueue = Webpack.getByKeys('handleSend');
const UserStore = Webpack.getStore('UserStore');
const Select = Webpack.getByStrings('selectionMode:"single",onSelectionChange:', "isSelected:", {
    searchExports: true
});

const dummyToBigFile = new Map();
const bigFileToDummy = new Map();
const uniqueIdToBigAndDummy = new Map();

const goFileResultByUploadId = new Map();
const inFlightUploadIds = new Set();

const attachmentsToUploadByNonce = new Map();

const cloudUploadIdToNonce = new Map();
const folderPromiseByBatchKey = new Map();

function removeId(uniqueId) {
    const files = uniqueIdToBigAndDummy.get(uniqueId);
    if (!files) return false;
    const { originalFile, dummy } = files;

    dummyToBigFile.delete(dummy);
    bigFileToDummy.delete(originalFile);
    uniqueIdToBigAndDummy.delete(uniqueId);
    goFileResultByUploadId.delete(uniqueId);
    inFlightUploadIds.delete(uniqueId);
    cloudUploadIdToNonce.delete(uniqueId);
}

function interceptDispatch(e) {
    if (e.type === 'UPLOAD_ATTACHMENT_REMOVE_FILE') {
        removeId(e.id);
    } else if (e.type === 'UPLOAD_ATTACHMENT_REMOVE_FILES') {
        for (const id of e.attachmentIds) {
            removeId(id);
        }
    }

    return false;
}

module.exports = class GoFileUpload {
    start() {
        MessageStoreDispatcher.addInterceptor(interceptDispatch);
        if (Data.load('GoFileUpload', 'uploads') == undefined) {
            Data.save('GoFileUpload', 'uploads', {});
        }
        if (Data.load('GoFileUpload', 'linkPosition') == undefined) {
            Data.save('GoFileUpload', 'linkPosition', 'after');
        }

        Patcher.before('GoFileUpload', CheckFilesModule, openModalIfFileExceedsSizeKey, (_, args, orig) => {
            args[0] = Array.from(args[0]);

            const oldGetCurrentUser = UserStore.getCurrentUser;
            const oldStaffFlag = oldGetCurrentUser().flags & 1;
            UserStore.getCurrentUser = () => {
                const user = oldGetCurrentUser();
                user.flags &= ~1;
                return user;
            };
            const currentUser = UserStore.getCurrentUser();
            const maxFileSize = getBiggestSize(
                getUserMaxFileSize({ location: 'web.filesExceedUploadLimits' }),
                getGuildMaxFileSize(args[1].guild_id)
            );
            UserStore.getCurrentUser = oldGetCurrentUser;
            currentUser.flags |= oldStaffFlag;

            for (let i = 0; i < args[0].length; i++) {
                const currentFile = args[0][i];

                if (currentFile.size > maxFileSize) {
                    const dummy = new File(['dummy'], currentFile.name, { type: currentFile.type });
                    args[0][i] = dummy;

                    dummyToBigFile.set(dummy, currentFile);
                    bigFileToDummy.set(currentFile, dummy);
                }
            }
        });

        Patcher.instead('GoFileUpload', CloudUploader.prototype, 'upload', (self, args, orig) => {
            const dummyFile = self.item.file;
            const originalFile = dummyToBigFile.get(dummyFile);

            if (!originalFile) {
                return orig.apply(self, args);
            }

            if (!uniqueIdToBigAndDummy.has(self.id)) {
                uniqueIdToBigAndDummy.set(self.id, { originalFile, dummy: dummyFile });
                self.status = 'NOT_STARTED';
                self.currentSize = originalFile.size;
                self.emit('progress', 0, originalFile.size);
                return;
            }

            if (inFlightUploadIds.has(self.id) || goFileResultByUploadId.has(self.id)) {
                return;
            }

            const batchKey = cloudUploadIdToNonce.get(self.id) ?? self.id;

            inFlightUploadIds.add(self.id);
            self.status = 'UPLOADING';
            performUpload(
                [{ file: originalFile, name: self.filename ?? originalFile.name, isSpoilered: !!self.spoiler }],
                batchKey,
                (loadedBytes, totalBytes) => {
                    self.loaded = loadedBytes;
                    self.currentSize = totalBytes;
                    self.emit('progress', loadedBytes, totalBytes);
                }
            ).then(([result]) => {
                inFlightUploadIds.delete(self.id);
                goFileResultByUploadId.set(self.id, result);
                self.handleComplete(self.id);
            }).catch(err => {
                inFlightUploadIds.delete(self.id);
                self.handleError(40005);
            });
        });

        Patcher.before('GoFileUpload', MessageActions, '_sendMessage', (_, args, orig) => {
            const extraInfo = args[2];
            const uploads = extraInfo?.attachmentsToUpload;

            if (uploads?.length > 0 && extraInfo.nonce != null) {
                attachmentsToUploadByNonce.set(extraInfo.nonce, uploads);
                for (const upload of uploads) {
                    cloudUploadIdToNonce.set(upload.id, extraInfo.nonce);
                }
            }
        });

        Patcher.before('GoFileUpload', MessageQueue, 'enqueue', (self, args, orig) => {
            const envelope = args[0];
            const nonce = envelope?.message?.nonce;
            if (nonce == null) return;

            const uploads = attachmentsToUploadByNonce.get(nonce);
            attachmentsToUploadByNonce.delete(nonce);
            folderPromiseByBatchKey.delete(nonce);
            if (!uploads?.length) return;

            for (const upload of uploads) {
                cloudUploadIdToNonce.delete(upload.id);
            }

            const attachments = envelope.message.attachments;
            if (!Array.isArray(attachments) || attachments.length !== uploads.length) return;

            const keepAttachments = [];
            const goFileForThisSend = [];

            uploads.forEach((cloudUpload, i) => {
                const result = goFileResultByUploadId.get(cloudUpload.id);
                if (result) {
                    goFileForThisSend.push(result);
                    removeId(cloudUpload.id);
                } else {
                    keepAttachments.push(attachments[i]);
                }
            });

            if (goFileForThisSend.length === 0) return;

            envelope.message.attachments = keepAttachments;

            const merged = [];
            for (const result of goFileForThisSend) {
                const existing = merged.find(r => r.downloadPage === result.downloadPage);
                if (existing) {
                    existing.name += ', ' + result.name;
                } else {
                    merged.push(result);
                }
            }

            const position = Data.load('GoFileUpload', 'linkPosition') || 'after';

            let downloadLinks = merged.map(result => `\n[${result.name}](${result.downloadPage})`).join('').trim();
            if (position === 'after') {
                downloadLinks = '\n' + downloadLinks;
            } else {
                downloadLinks = downloadLinks + '\n';
            }

            const premiumType = UserStore.getCurrentUser().premiumType;
            const maxMessageLength = (premiumType === null || premiumType === 0)
                ? 2000
                : 4000;
            const currentContentLength = envelope.message.content?.length || 0;
            const remainingLength = maxMessageLength - currentContentLength;
            const linksLength = downloadLinks.length;

            if (linksLength > remainingLength) {
                const truncatedContent = envelope.message.content?.slice(0, maxMessageLength - linksLength) || '';
                const cutContent = envelope.message.content?.slice(maxMessageLength - linksLength) || '';

                envelope.message.content = position === 'after'
                    ? truncatedContent + downloadLinks
                    : downloadLinks + truncatedContent;

                if (cutContent?.length > 0) {
                    setTimeout(() => {
                        MessageActions.sendMessage(
                            envelope.message.channelId,
                            { content: cutContent, invalidEmojis: [], tts: false, validNonShortcutEmojis: [] },
                            undefined,
                            { alsoForwardToChannelId: undefined, location: 'chat_input' }
                        );
                    }, 2000);
                }
            } else {
                envelope.message.content = position === 'after'
                    ? (envelope.message.content ?? '') + downloadLinks
                    : downloadLinks + (envelope.message.content ?? '');
            }
        });
    }

    getSettingsPanel() {
        return React.createElement(SettingsPanel);
    }

    stop() {
        Patcher.unpatchAll('GoFileUpload');
        MessageStoreDispatcher._interceptors.splice(MessageStoreDispatcher._interceptors.indexOf(interceptDispatch), 1);
        dummyToBigFile.clear();
        bigFileToDummy.clear();
        uniqueIdToBigAndDummy.clear();
        goFileResultByUploadId.clear();
        inFlightUploadIds.clear();
        attachmentsToUploadByNonce.clear();
        cloudUploadIdToNonce.clear();
        folderPromiseByBatchKey.clear();
    }
};

function SettingsPanel() {
    const [linkPosition, setLinkPosition] = React.useState(
        Data.load('GoFileUpload', 'linkPosition') || 'after'
    );
    const [uploads, setUploads] = React.useState(
        () => Data.load('GoFileUpload', 'uploads') || {}
    );

    return React.createElement('div', { style: { padding: '10px', minHeight: '200px' } },
        React.createElement('style', null, `
        .folder-container {
            background-color: var(--control-secondary-background-default);
            border-radius: 5px;
            padding: 5px;
            margin-bottom: 5px;
            & h3 {
                font-size: 1.2em;
                font-weight: bold;
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-left: 3px;
                &:has(+ul *) {
                    margin-bottom: 5px;
                }
                & .delete-button {
                    margin: 0 5px 0 0;
                }
            }
        }
        .file-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 3px 0;
            border-radius: 3px;
            background-color: var(--control-secondary-background-hover);
            & span {
                margin-left: 5px;
            }
        }
        .file-item:not(:last-child) {
            margin-bottom: 3px;
        }
        .delete-button {
            background-color: var(--control-critical-primary-background-default);
            border: none;
            cursor: pointer;
            color: white;
            font-size: 16px;
            border-radius: 3px;
            margin: 2px 5px 2px 5px;
        }
        .delete-button:hover {
            background-color: var(--control-critical-primary-background-hover);
        }
        h2 {
            padding-bottom: 10px;
            font-size: 1.5em;
            font-weight: 600;
            &:not(:first-of-type) {
                margin-top: 20px;
            }
        }
        p {
            padding-bottom: 5px;
        }
        `),

        React.createElement('h2', null, 'Settings'),

        React.createElement('p', null, 'Download links are placed at the:'),
        React.createElement(Select, {
            options: [
                { id: 'after', value: 'after', label: 'End of the message' },
                { id: 'before', value: 'before', label: 'Start of the message' }
            ],
            value: linkPosition,
            select: (value) => {
                setLinkPosition(value);
                Data.save('GoFileUpload', 'linkPosition', value);
            },
            serialize: (value) => value,
            isSelected: (value) => value === linkPosition
        }),

        React.createElement('h2', null, 'Uploads'),

        Object.keys(uploads).map((folderId) => (
            React.createElement('div', { key: folderId, className: 'folder-container' },
                React.createElement('h3', null,
                    React.createElement('a', { href: uploads[folderId].downloadPage, target: '_blank', rel: 'noopener noreferrer' }, uploads[folderId].name),
                    React.createElement('button', {
                        className: 'delete-button', onClick: async (e) => {
                            const folder = uploads[folderId];
                            if (!folder) return;

                            try {
                                await deleteEntry(folderId, folder.associatedToken);

                                setUploads(prev => {
                                    const next = { ...prev };
                                    delete next[folderId];

                                    Data.save('GoFileUpload', 'uploads', next);
                                    return next;
                                });
                            } catch (error) {
                                alert(`Error deleting folder: ${error.message}`);
                            }
                        }
                    },
                        'Delete'
                    )
                ),
                React.createElement('ul', null,
                    uploads[folderId].files.map((file) => (
                        React.createElement('li', { key: file.id, className: 'file-item' },
                            React.createElement('span', null, file.name),
                            React.createElement('button', {
                                className: 'delete-button', onClick: async (e) => {
                                    const folder = uploads[folderId];
                                    if (!folder) return;

                                    const foundFile = folder.files.find(f => f.id === file.id);
                                    if (!foundFile) return;

                                    try {
                                        await deleteEntry(foundFile.id, foundFile.associatedToken);

                                        setUploads(prev => {
                                            const next = {
                                                ...prev,
                                                [folderId]: {
                                                    ...prev[folderId],
                                                    files: prev[folderId].files.filter(
                                                        f => f.id !== foundFile.id
                                                    )
                                                }
                                            };

                                            Data.save('GoFileUpload', 'uploads', next);
                                            return next;
                                        });
                                    } catch (error) {
                                        alert(`Error deleting file: ${error.message}`);
                                    }
                                }
                            },
                                'Delete'
                            )
                        )
                    ))
                )
            )
        ))
    );
}

let goFileGuest = {};
let goFileAccount = {};

async function makeGoFileGuest() {
    const response = await fetch('https://api.gofile.io/accounts', { method: 'POST' });

    if (!response.ok) {
        throw new Error(`Failed to create GoFile guest account: ${response.status} ${response.statusText} ${await response.text()}`);
    }

    const result = await response.json();
    goFileGuest = result.data;
    await getGoFileAccountInfo(goFileGuest.token);
}

async function getGoFileAccountInfo(token) {
    const response = await fetch('https://api.gofile.io/accounts/website', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to get account info: ${response.status} ${response.statusText} ${await response.text()}`);
    }

    const result = await response.json();
    if (/^guest\d+@gofile\.io$/.test(result.data.email)) {
        result.data.email = result.data.email.replace(/@.*/, '');
    }
    goFileAccount = result.data;
}

async function createFolder() {
    const response = await fetch('https://api.gofile.io/contents/createfolder', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${goFileGuest.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            parentFolderId: goFileAccount.rootFolder,
            public: true
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to create folder: ${response.status} ${response.statusText} ${await response.text()}`);
    }

    const result = await response.json();
    return result;
}

async function getSharedFolder(batchKey) {
    let promise = folderPromiseByBatchKey.get(batchKey);
    if (!promise) {
        promise = createSharedFolder();
        folderPromiseByBatchKey.set(batchKey, promise);
        promise.catch(() => {
            if (folderPromiseByBatchKey.get(batchKey) === promise) {
                folderPromiseByBatchKey.delete(batchKey);
            }
        });
    }
    return promise;
}

async function createSharedFolder(depth = 0) {
    if (depth > 2) {
        throw new Error('Failed to create GoFile folder after multiple attempts.');
    }

    try {
        if (!goFileGuest.token) {
            await makeGoFileGuest();
        }

        const folderResponse = await createFolder();
        const downloadPage = `https://gofile.io/d/${folderResponse.data.code}`;

        const allUploads = Data.load('GoFileUpload', 'uploads') || {};
        allUploads[folderResponse.data.id] = { name: folderResponse.data.name, downloadPage, files: [], associatedToken: goFileGuest.token };
        Data.save('GoFileUpload', 'uploads', allUploads);

        return { folderId: folderResponse.data.id, downloadPage, token: goFileGuest.token };
    } catch (error) {
        goFileGuest = {};
        goFileAccount = {};
        return createSharedFolder(depth + 1);
    }
}

async function uploadFile(file, folderId, token, onProgress) {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('token', token);
    formData.append('folderId', folderId);
    formData.append('file', new File([file.file], file.name, { type: file.file.type }));

    return new Promise((resolve, reject) => {
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && onProgress) {
                onProgress(event.loaded, event.total);
            }
        };

        xhr.open('POST', 'https://upload.gofile.io/uploadfile', true);

        xhr.onload = () => {
            if (xhr.status === 200) {
                resolve(JSON.parse(xhr.responseText));
            } else {
                reject(new Error(`Upload failed with status ${xhr.status} ${xhr.statusText} ${xhr.responseText}`));
            }
        };

        xhr.onerror = () => reject(new Error('Network error'));

        xhr.send(formData);
    });
}

async function performUpload(files, batchKey, onProgress) {
    const failure = [{ name: '`failed`', downloadPage: 'failed' }];

    let folder;
    try {
        folder = await getSharedFolder(batchKey);
    } catch (error) {
        alert(`Error creating folder: ${error.message}`);
        return failure;
    }

    const allUploads = Data.load('GoFileUpload', 'uploads') || {};
    const uploadResults = [];

    for (const file of files) {
        const formatStringOpen = file.isSpoilered ? '||`' : '`';
        const formatStringClose = file.isSpoilered ? '`||' : '`';

        try {
            const uploadResponse = await uploadFile(file, folder.folderId, folder.token, onProgress);

            const entry = allUploads[folder.folderId] ?? { name: folder.folderId, downloadPage: folder.downloadPage, files: [], associatedToken: folder.token };
            entry.files.push({ name: file.name, id: uploadResponse.data.id, associatedToken: folder.token });
            allUploads[folder.folderId] = entry;

            uploadResults.push({ name: formatStringOpen + file.name + formatStringClose, downloadPage: uploadResponse.data.downloadPage ?? folder.downloadPage });
        } catch (error) {
            alert(`Error uploading file: ${error.message}`);
            uploadResults.push({ name: formatStringOpen + file.name + formatStringClose, downloadPage: 'failed' });
        }
    }

    Data.save('GoFileUpload', 'uploads', allUploads);
    return uploadResults;
}

async function deleteEntry(id, token) {
    const response = await fetch('https://api.gofile.io/contents', {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contentsId: id,
            proof: 'Deletion requested by user'
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to delete entry: ${response.status} ${response.statusText} ${await response.text()}`);
    }

    return response.json();
}
